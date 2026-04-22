import { app } from "/scripts/app.js";

const NODE_NAMES = new Set(["EnumCombo", "EnumComboAdvanced"]);
const FALLBACK_CHOICES = ["OPTION_A", "OPTION_B"];
const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const STRING_WIDGET_NAMES = ["enum_definition", "text", "string", "value"];
const EXTENSION_NAME = "EnumCombo.DynamicChoices";
const GRAPH_REFRESH_ATTEMPTS = 6;
const NODE_REFRESH_ATTEMPTS = 8;
const GRAPH_REFRESH_DELAY_MS = 75;

let graph_refresh_token = 0;
let load_graph_hook_installed = false;
let serialized_enum_definitions = new Map();
let serialized_enum_choices = new Map();
const node_refresh_tokens = new Map();

function stripComments(text)
{
	let result = "";
	let index = 0;
	let inBlockComment = false;
	let quoteChar = null;
	let escaped = false;

	while (index < text.length)
	{
		const char = text[index];
		const nextChar = index + 1 < text.length ? text[index + 1] : "";

		if (inBlockComment)
		{
			if (char === "*" && nextChar === "/")
			{
				inBlockComment = false;
				index += 2;
				continue;
			}

			if (char === "\n")
			{
				result += "\n";
			}

			index += 1;
			continue;
		}

		if (quoteChar !== null)
		{
			result += char;

			if (escaped)
			{
				escaped = false;
			}
			else if (char === "\\")
			{
				escaped = true;
			}
			else if (char === quoteChar)
			{
				quoteChar = null;
			}

			index += 1;
			continue;
		}

		if (char === "\"" || char === "'")
		{
			quoteChar = char;
			result += char;
			index += 1;
			continue;
		}

		if (char === "/" && nextChar === "*")
		{
			inBlockComment = true;
			index += 2;
			continue;
		}

		if (char === "/" && nextChar === "/")
		{
			while (index < text.length && text[index] !== "\n")
			{
				index += 1;
			}
			continue;
		}

		if (char === "#")
		{
			while (index < text.length && text[index] !== "\n")
			{
				index += 1;
			}
			continue;
		}

		result += char;
		index += 1;
	}

	return result;
}

function stripLineTerminator(line)
{
	let cleanedLine = line.trim();

	while (cleanedLine.endsWith(",") || cleanedLine.endsWith(";"))
	{
		cleanedLine = cleanedLine.slice(0, -1).trim();
	}

	return cleanedLine;
}

function readQuotedName(line)
{
	const quoteChar = line[0];
	let index = 1;
	let escaped = false;
	let name = "";

	while (index < line.length)
	{
		const char = line[index];

		if (escaped)
		{
			if (char === "n")
			{
				name += "\n";
			}
			else if (char === "t")
			{
				name += "\t";
			}
			else
			{
				name += char;
			}

			escaped = false;
		}
		else if (char === "\\")
		{
			escaped = true;
		}
		else if (char === quoteChar)
		{
			return {
				name,
				remainder: line.slice(index + 1).trim()
			};
		}
		else
		{
			name += char;
		}

		index += 1;
	}

	return null;
}

function parseEnumNames(enumDefinition)
{
	const names = [];
	const seenNames = new Set();
	const lines = stripComments(enumDefinition || "").split(/\r?\n/);

	for (const rawLine of lines)
	{
		const line = stripLineTerminator(rawLine);
		let name = "";

		if (!line)
		{
			continue;
		}

		if (line[0] === "\"" || line[0] === "'")
		{
			const quoted = readQuotedName(line);
			if (!quoted || !quoted.name)
			{
				continue;
			}

			name = quoted.name;
		}
		else
		{
			name = (line.includes("=") ? line.split("=")[0] : line).trim();
			if (!IDENTIFIER_PATTERN.test(name))
			{
				continue;
			}
		}

		if (!seenNames.has(name))
		{
			names.push(name);
			seenNames.add(name);
		}
	}

	return names.length > 0 ? names : FALLBACK_CHOICES;
}

function getWidget(node, name)
{
	const widgets = getNodeWidgets(node);
	return widgets.find((widget) => widget.name === name);
}

function getNodeWidgets(node)
{
	if (!node)
	{
		return [];
	}

	try
	{
		const widgets = node.widgets;
		return Array.isArray(widgets) ? widgets : [];
	}
	catch (error)
	{
		return [];
	}
}

function getEnumNodeName(target)
{
	const candidate_names = [
		target?.comfyClass,
		target?.constructor?.comfyClass,
		target?.nodeData?.name,
		target?.constructor?.nodeData?.name,
		target?.type,
		target?.constructor?.type,
		target?.title,
		target?.constructor?.title,
	];

	for (const candidate_name of candidate_names)
	{
		if (typeof candidate_name === "string" && NODE_NAMES.has(candidate_name))
		{
			return candidate_name;
		}
	}

	return null;
}

function isEnumNode(node)
{
	return getEnumNodeName(node) !== null;
}

function isEnumNodeType(nodeType)
{
	return getEnumNodeName(nodeType) !== null;
}

function getRegisteredNodeTypes()
{
	const registered_node_types = globalThis?.LiteGraph?.registered_node_types;
	return registered_node_types && typeof registered_node_types === "object"
		? Object.values(registered_node_types)
		: [];
}

function getWidgetValues(widget)
{
	if (Array.isArray(widget?.enumComboValues))
	{
		return widget.enumComboValues;
	}

	if (Array.isArray(widget?.values))
	{
		return widget.values;
	}

	const optionValues = widget?.options?.values;
	return Array.isArray(optionValues) ? optionValues : [];
}

function cloneValues(values)
{
	return Array.isArray(values) ? values.slice() : [];
}

function setWidgetOptionValues(widget, nextOptionValues)
{
	if (!widget)
	{
		return false;
	}

	const widgetOptions = widget.options || {};
	widget.options = widgetOptions;

	try
	{
		widgetOptions.values = nextOptionValues;
		if (widget?.options?.values === nextOptionValues)
		{
			return true;
		}
	}
	catch (error)
	{
	}

	try
	{
		Object.defineProperty(widgetOptions, "values", {
			configurable: true,
			enumerable: true,
			writable: true,
			value: nextOptionValues,
		});

		if (widget?.options?.values === nextOptionValues)
		{
			return true;
		}
	}
	catch (error)
	{
	}

	try
	{
		const replacementOptions = Object.assign(
			Object.create(Object.getPrototypeOf(widgetOptions) || null),
			widgetOptions
		);

		Object.defineProperty(replacementOptions, "values", {
			configurable: true,
			enumerable: true,
			writable: true,
			value: nextOptionValues,
		});

		widget.options = replacementOptions;
		return widget?.options?.values === nextOptionValues;
	}
	catch (error)
	{
	}

	return false;
}

function getGraphLink(graph, linkId)
{
	if (linkId == null || !graph)
	{
		return null;
	}

	if (typeof graph.getLink === "function")
	{
		return graph.getLink(linkId) || null;
	}

	const internalLinks = graph._links;
	if (internalLinks instanceof Map)
	{
		return internalLinks.get(linkId) || null;
	}

	if (internalLinks && typeof internalLinks === "object")
	{
		return internalLinks[linkId] || null;
	}

	return null;
}

function getSourceNodeForInput(node, inputName)
{
	const input = node.inputs?.find((item) => item.name === inputName);
	const link = getGraphLink(node.graph, input?.link);

	if (!link)
	{
		return null;
	}

	return node.graph?.getNodeById?.(link.origin_id) || null;
}

function getSerializedNodeById(graphData, nodeId)
{
	if (!Array.isArray(graphData?.nodes))
	{
		return null;
	}

	return graphData.nodes.find((node) => node?.id === nodeId) || null;
}

function getSerializedGraphLink(graphData, linkId)
{
	if (!graphData || linkId == null)
	{
		return null;
	}

	const links = graphData.links;
	if (Array.isArray(links))
	{
		return links.find((link) =>
		{
			if (Array.isArray(link))
			{
				return link[0] === linkId;
			}

			return link?.id === linkId;
		}) || null;
	}

	if (links && typeof links === "object")
	{
		const directLink = links[linkId];
		if (directLink)
		{
			return directLink;
		}

		return Object.values(links).find((link) =>
		{
			if (Array.isArray(link))
			{
				return link[0] === linkId;
			}

			return link?.id === linkId;
		}) || null;
	}

	return null;
}

function getSerializedLinkOriginId(link)
{
	if (Array.isArray(link))
	{
		return link[1] ?? null;
	}

	return link?.origin_id ?? null;
}

function getSerializedSourceNodeForInput(graphData, nodeData, inputName)
{
	const input = nodeData?.inputs?.find((item) => item?.name === inputName);
	const link = getSerializedGraphLink(graphData, input?.link);
	const originId = getSerializedLinkOriginId(link);

	return originId == null ? null : getSerializedNodeById(graphData, originId);
}

function getSerializedStringWidgetValue(nodeData)
{
	if (!nodeData)
	{
		return null;
	}

	const widgetValues = Array.isArray(nodeData.widgets_values) ? nodeData.widgets_values : [];
	const inputs = Array.isArray(nodeData.inputs) ? nodeData.inputs : [];

	for (const name of STRING_WIDGET_NAMES)
	{
		const input = inputs.find((item) => item?.widget?.name === name && item.link == null);
		if (!input)
		{
			continue;
		}

		const inputIndex = inputs.indexOf(input);
		if (inputIndex >= 0 && typeof widgetValues[inputIndex] === "string")
		{
			return widgetValues[inputIndex];
		}
	}

	if (widgetValues.length === 1 && typeof widgetValues[0] === "string")
	{
		return widgetValues[0];
	}

	const serializedStringValues = widgetValues.filter((value) => typeof value === "string");
	if (serializedStringValues.length === 1)
	{
		return serializedStringValues[0];
	}

	return null;
}

function getSerializedLinkedStringValue(graphData, nodeData, visited = new Set())
{
	if (!nodeData || visited.has(nodeData.id))
	{
		return null;
	}

	visited.add(nodeData.id);

	const widgetValue = getSerializedStringWidgetValue(nodeData);
	if (widgetValue !== null)
	{
		return widgetValue;
	}

	for (const input of nodeData.inputs || [])
	{
		const link = getSerializedGraphLink(graphData, input.link);
		const originId = getSerializedLinkOriginId(link);
		const sourceNode = originId == null ? null : getSerializedNodeById(graphData, originId);
		const linkedValue = getSerializedLinkedStringValue(graphData, sourceNode, visited);

		if (linkedValue !== null)
		{
			return linkedValue;
		}
	}

	return null;
}

function getSerializedChoiceValue(nodeData)
{
	if (!nodeData)
	{
		return null;
	}

	const widgetValues = Array.isArray(nodeData.widgets_values) ? nodeData.widgets_values : [];
	if (widgetValues.length > 0 && typeof widgetValues[0] === "string")
	{
		return widgetValues[0];
	}

	return null;
}

function buildSerializedEnumState(graphData)
{
	const definitions = new Map();
	const choices = new Map();
	const nodes = Array.isArray(graphData?.nodes) ? graphData.nodes : [];

	for (const nodeData of nodes)
	{
		if (!NODE_NAMES.has(nodeData?.type))
		{
			continue;
		}

		const linkedSourceNode = getSerializedSourceNodeForInput(graphData, nodeData, "enum_definition");
		const definitionValue = getSerializedLinkedStringValue(graphData, linkedSourceNode);
		if (typeof definitionValue === "string")
		{
			definitions.set(nodeData.id, definitionValue);
		}

		const choiceValue = getSerializedChoiceValue(nodeData);
		if (typeof choiceValue === "string")
		{
			choices.set(nodeData.id, choiceValue);
		}
	}

	return {
		definitions,
		choices,
	};
}

function getCachedDefinitionValue(node)
{
	if (typeof node?.enumComboCachedDefinition === "string")
	{
		return node.enumComboCachedDefinition;
	}

	if (!hasLinkedDefinitionInput(node))
	{
		return null;
	}

	const serializedDefinition = serialized_enum_definitions.get(node?.id);
	return typeof serializedDefinition === "string" ? serializedDefinition : null;
}

function getPreferredChoiceValue(node, widget, availableValues)
{
	const candidateValues = [
		widget?.value,
		node?.enumComboCachedChoice,
		serialized_enum_choices.get(node?.id),
	];
	const widgetValues = Array.isArray(node?.widgets_values) ? node.widgets_values : [];
	if (widgetValues.length === 1 && typeof widgetValues[0] === "string")
	{
		candidateValues.push(widgetValues[0]);
	}

	for (const candidateValue of candidateValues)
	{
		if (typeof candidateValue === "string" && availableValues.includes(candidateValue))
		{
			return candidateValue;
		}
	}

	return null;
}

function getCurrentChoiceValues(node)
{
	return parseEnumNames(getDefinitionValue(node));
}

function getStringWidgetValue(node)
{
	if (!node)
	{
		return null;
	}

	const widgets = getNodeWidgets(node);
	const widget_values = Array.isArray(node.widgets_values) ? node.widgets_values : [];

	for (const name of STRING_WIDGET_NAMES)
	{
		const widget = widgets.find((item) => item.name === name);
		if (typeof widget?.value === "string")
		{
			return widget.value;
		}
	}

	for (const name of STRING_WIDGET_NAMES)
	{
		const widget_index = widgets.findIndex((item) => item.name === name);
		if (widget_index >= 0 && typeof widget_values[widget_index] === "string")
		{
			return widget_values[widget_index];
		}
	}

	const inputs = Array.isArray(node.inputs) ? node.inputs : [];
	for (const name of STRING_WIDGET_NAMES)
	{
		const input_index = inputs.findIndex((input) => input?.widget?.name === name);
		if (input_index >= 0 && typeof widget_values[input_index] === "string")
		{
			return widget_values[input_index];
		}
	}

	const stringWidget = widgets.find((widget) => typeof widget?.value === "string");
	if (typeof stringWidget?.value === "string")
	{
		return stringWidget.value;
	}

	if (widget_values.length === 1 && typeof widget_values[0] === "string")
	{
		return widget_values[0];
	}

	const serialized_string_values = widget_values.filter((value) => typeof value === "string");
	if (serialized_string_values.length === 1)
	{
		return serialized_string_values[0];
	}

	return null;
}

function getLinkedStringValue(node, visited = new Set())
{
	if (!node || visited.has(node.id))
	{
		return null;
	}

	visited.add(node.id);

	const widgetValue = getStringWidgetValue(node);
	if (widgetValue !== null)
	{
		return widgetValue;
	}

	for (const input of node.inputs || [])
	{
		const link = getGraphLink(node.graph, input.link);
		const sourceNode = link ? node.graph?.getNodeById?.(link.origin_id) : null;
		const linkedValue = getLinkedStringValue(sourceNode, visited);

		if (linkedValue !== null)
		{
			return linkedValue;
		}
	}

	return null;
}

function collectLinkedStringNodes(node, results = new Set(), visited = new Set())
{
	if (!node || visited.has(node.id))
	{
		return results;
	}

	visited.add(node.id);

	if (getStringWidgetValue(node) !== null)
	{
		results.add(node);
		return results;
	}

	for (const input of node.inputs || [])
	{
		const link = getGraphLink(node.graph, input.link);
		const sourceNode = link ? node.graph?.getNodeById?.(link.origin_id) : null;
		collectLinkedStringNodes(sourceNode, results, visited);
	}

	return results;
}

function getDefinitionValue(node)
{
	const sourceNode = getSourceNodeForInput(node, "enum_definition");
	const linkedValue = getLinkedStringValue(sourceNode);

	if (linkedValue !== null)
	{
		node.enumComboCachedDefinition = linkedValue;
		return linkedValue;
	}

	const cachedDefinition = getCachedDefinitionValue(node);
	if (cachedDefinition !== null)
	{
		return cachedDefinition;
	}

	const definitionWidget = getWidget(node, "enum_definition");
	if (definitionWidget)
	{
		if (typeof definitionWidget.value === "string")
		{
			node.enumComboCachedDefinition = definitionWidget.value;
		}

		return definitionWidget.value;
	}

	return null;
}

function hasLinkedDefinitionInput(node)
{
	return node.inputs?.some((input) => input?.name === "enum_definition" && input.link != null) === true;
}

function bindSourceWidgetRefresh(enumNode)
{
	clearSourceWidgetRefresh(enumNode);

	const sourceNode = getSourceNodeForInput(enumNode, "enum_definition");
	const stringNodes = collectLinkedStringNodes(sourceNode);
	const sourceWidgets = new Set();

	for (const stringNode of stringNodes)
	{
		for (const widget of getNodeWidgets(stringNode))
		{
			if (typeof widget?.value !== "string")
			{
				continue;
			}

			if (!widget.enumComboSubscribers)
			{
				const current_callback = typeof widget.callback === "function" ? widget.callback : null;
				const original_callback = current_callback?.__enum_combo_wrapper === true
					? current_callback.__enum_combo_original_callback || null
					: current_callback;

				widget.enumComboSubscribers = new Set();
				widget.enumComboOriginalCallback = original_callback;

				const wrapped_callback = function()
				{
					const result = widget.enumComboOriginalCallback?.apply(this, arguments);

					for (const subscriber of Array.from(widget.enumComboSubscribers))
					{
						if (!subscriber.graph)
						{
							widget.enumComboSubscribers.delete(subscriber);
							continue;
						}

						refreshEnumChoices(subscriber);
					}

					return result;
				};

				wrapped_callback.__enum_combo_wrapper = true;
				wrapped_callback.__enum_combo_original_callback = original_callback;
				widget.enumComboWrappedCallback = wrapped_callback;
				widget.callback = wrapped_callback;
			}

			widget.enumComboSubscribers.add(enumNode);
			sourceWidgets.add(widget);
		}
	}

	enumNode.enumComboSourceWidgets = sourceWidgets;
}

function clearSourceWidgetRefresh(enumNode)
{
	const sourceWidgets = enumNode?.enumComboSourceWidgets;
	if (!(sourceWidgets instanceof Set))
	{
		return;
	}

	for (const widget of Array.from(sourceWidgets))
	{
		if (!widget?.enumComboSubscribers)
		{
			continue;
		}

		widget.enumComboSubscribers.delete(enumNode);

		if (widget.enumComboSubscribers.size === 0)
		{
			if (widget.callback === widget.enumComboWrappedCallback)
			{
				widget.callback = widget.enumComboOriginalCallback || undefined;
			}

			delete widget.enumComboOriginalCallback;
			delete widget.enumComboWrappedCallback;
			delete widget.enumComboSubscribers;
		}
	}

	sourceWidgets.clear();
}

function setComboValues(node, widget, values)
{
	if (!widget || widget.enumComboUpdating)
	{
		return;
	}

	widget.enumComboUpdating = true;

	try
	{
	const nextValues = Array.isArray(values) && values.length > 0 ? cloneValues(values) : cloneValues(FALLBACK_CHOICES);
	const preferredValue = getPreferredChoiceValue(node, widget, nextValues);

	widget.enumComboValues = nextValues;
	widget.values = cloneValues(nextValues);
	setWidgetOptionValues(widget, cloneValues(nextValues));

	if (typeof preferredValue === "string" && nextValues.includes(preferredValue))
	{
		if (widget.value !== preferredValue)
		{
			widget.value = preferredValue;
		}

		node.enumComboCachedChoice = preferredValue;
		return;
	}

	if (!nextValues.includes(widget.value))
	{
		if (widget.value !== nextValues[0])
		{
			widget.value = nextValues[0];
		}
	}

	if (typeof widget.value === "string")
	{
		node.enumComboCachedChoice = widget.value;
	}
	}
	finally
	{
		widget.enumComboUpdating = false;
	}
}

function setChoiceValue(widget, node, value, options)
{
	if (typeof widget?.setValue === "function")
	{
		widget.setValue(value, options);
	}
	else
	{
		const oldValue = widget.value;
		widget.value = value;
		widget.callback?.(widget.value, options.canvas, node, options.canvas?.graph_mouse, options.e);
		node.onWidgetChanged?.(widget.name ?? "", value, oldValue, widget);
		if (node.graph)
		{
			node.graph._version += 1;
		}
	}

	if (typeof widget?.value === "string")
	{
		node.enumComboCachedChoice = widget.value;
	}

	node.graph?.setDirtyCanvas?.(true, true);
}

function changeChoiceByDelta(widget, node, delta, options)
{
	const values = getCurrentChoiceValues(node);
	const currentIndex = Math.max(0, values.indexOf(String(widget.value)));
	const nextIndex = Math.max(0, Math.min(values.length - 1, currentIndex + delta));
	const nextValue = values[nextIndex];

	setComboValues(node, widget, values);
	setChoiceValue(widget, node, nextValue, options);
}

function showChoiceMenu(widget, node, options)
{
	const contextMenuClass = globalThis?.LiteGraph?.ContextMenu;
	if (!contextMenuClass)
	{
		return;
	}

	const values = getCurrentChoiceValues(node);
	setComboValues(node, widget, values);

	new contextMenuClass(values, {
		scale: Math.max(1, options.canvas.ds.scale),
		event: options.e,
		className: "dark",
		callback: (value) =>
		{
			setChoiceValue(widget, node, value, options);
		},
	});
}

function refreshEnumChoices(node)
{
	if (!node || node.enumComboRefreshing)
	{
		return;
	}

	node.enumComboRefreshing = true;

	try
	{
	const choiceWidget = getWidget(node, "choice");
	const enumDefinition = getDefinitionValue(node);

	if (!choiceWidget)
	{
		return;
	}

	const names = parseEnumNames(enumDefinition);
	const currentValues = getWidgetValues(choiceWidget);
	const valuesChanged = JSON.stringify(names) !== JSON.stringify(currentValues);
	const valueChanged = !names.includes(choiceWidget.value);
	const isFallbackValues = names.length === FALLBACK_CHOICES.length
		&& names.every((name, index) => name === FALLBACK_CHOICES[index]);

	if (typeof enumDefinition === "string")
	{
		node.enumComboCachedDefinition = enumDefinition;
	}

	if (valuesChanged || valueChanged)
	{
		setComboValues(node, choiceWidget, names);
		node.graph?.setDirtyCanvas?.(true, true);
	}

	if (isFallbackValues && hasLinkedDefinitionInput(node))
	{
		scheduleNodeRefresh(node, NODE_REFRESH_ATTEMPTS);
	}
	}
	finally
	{
		node.enumComboRefreshing = false;
	}
}

function bindChoiceWidgetRefresh(node)
{
	const choiceWidget = getWidget(node, "choice");

	if (!choiceWidget)
	{
		return;
	}

	const initialValues = getWidgetValues(choiceWidget);
	const nextValues = initialValues.length > 0 ? cloneValues(initialValues) : cloneValues(FALLBACK_CHOICES);
	choiceWidget.enumComboValues = cloneValues(nextValues);
	choiceWidget.values = cloneValues(nextValues);
	setWidgetOptionValues(choiceWidget, cloneValues(nextValues));

	if (choiceWidget.enumComboRefreshBound)
	{
		return;
	}

	const originalCallback = choiceWidget.callback;
	choiceWidget.callback = function()
	{
		const result = originalCallback?.apply(this, arguments);
		const targetNode = this?.node || node;

		if (targetNode && typeof this?.value === "string")
		{
			targetNode.enumComboCachedChoice = this.value;
		}

		return result;
	};

	const originalOnClick = choiceWidget.onClick;
	choiceWidget.onClick = function(options)
	{
		const targetNode = options?.node || this?.node || node;
		if (!targetNode)
		{
			return originalOnClick?.apply(this, arguments);
		}

		refreshEnumChoices(targetNode);

		const e = options?.e;
		const canvas = options?.canvas;
		if (!e || !canvas)
		{
			return originalOnClick?.apply(this, arguments);
		}

		const x = e.canvasX - targetNode.pos[0];
		const width = this.width || targetNode.size[0];
		if (x < 40)
		{
			changeChoiceByDelta(this, targetNode, -1, options);
			return;
		}

		if (x > width - 40)
		{
			changeChoiceByDelta(this, targetNode, 1, options);
			return;
		}

		showChoiceMenu(this, targetNode, options);
	};

	choiceWidget.canIncrement = function()
	{
		const targetNode = this?.node || node;
		const values = getCurrentChoiceValues(targetNode);
		if (!(values.length > 1))
		{
			return false;
		}

		const firstValue = values[0];
		const lastValue = values[values.length - 1];
		if (firstValue === lastValue)
		{
			return true;
		}

		return this.value !== lastValue;
	};

	choiceWidget.canDecrement = function()
	{
		const targetNode = this?.node || node;
		const values = getCurrentChoiceValues(targetNode);
		if (!(values.length > 1))
		{
			return false;
		}

		const firstValue = values[0];
		const lastValue = values[values.length - 1];
		if (firstValue === lastValue)
		{
			return true;
		}

		return this.value !== firstValue;
	};

	choiceWidget.incrementValue = function(options)
	{
		changeChoiceByDelta(this, options?.node || this?.node || node, 1, options);
	};

	choiceWidget.decrementValue = function(options)
	{
		changeChoiceByDelta(this, options?.node || this?.node || node, -1, options);
	};

	choiceWidget.enumComboRefreshBound = true;
}

function seedNodeStateFromSerializedData(node)
{
	const serializedDefinition = serialized_enum_definitions.get(node?.id);
	if (typeof serializedDefinition === "string" && typeof node?.enumComboCachedDefinition !== "string")
	{
		node.enumComboCachedDefinition = serializedDefinition;
	}

	const serializedChoice = serialized_enum_choices.get(node?.id);
	if (typeof serializedChoice === "string" && typeof node?.enumComboCachedChoice !== "string")
	{
		node.enumComboCachedChoice = serializedChoice;
	}
}

function refreshEnumNode(node)
{
	if (!isEnumNode(node))
	{
		return;
	}

	seedNodeStateFromSerializedData(node);
	bindChoiceWidgetRefresh(node);
	bindSourceWidgetRefresh(node);
	refreshEnumChoices(node);
}

function walkGraphNodes(graph, callback, visited_graphs = new Set())
{
	if (!graph || visited_graphs.has(graph))
	{
		return;
	}

	visited_graphs.add(graph);

	const nodes = Array.isArray(graph._nodes) ? graph._nodes : [];
	for (const node of nodes)
	{
		callback(node);

		if (node?.subgraph)
		{
			walkGraphNodes(node.subgraph, callback, visited_graphs);
		}
	}
}

function refreshAllEnumNodes()
{
	const visited_graphs = new Set();
	const graph_candidates = [
		app?.graph,
		app?.canvas?.graph,
	];

	for (const graph of graph_candidates)
	{
		walkGraphNodes(graph, (node) =>
		{
			if (!isEnumNode(node))
			{
				return;
			}

			refreshEnumNode(node);
		}, visited_graphs);
	}
}

function scheduleGraphRefresh(attempts = GRAPH_REFRESH_ATTEMPTS)
{
	graph_refresh_token += 1;
	const current_token = graph_refresh_token;

	const run_refresh = (remaining_attempts) =>
	{
		if (current_token !== graph_refresh_token)
		{
			return;
		}

		refreshAllEnumNodes();

		if (remaining_attempts > 1)
		{
			setTimeout(() =>
			{
				run_refresh(remaining_attempts - 1);
			}, GRAPH_REFRESH_DELAY_MS);
		}
	};

	setTimeout(() =>
	{
		run_refresh(Math.max(1, attempts));
	}, 0);
}

function scheduleNodeRefresh(node, attempts = NODE_REFRESH_ATTEMPTS)
{
	if (!node)
	{
		return;
	}

	if (node.id == null)
	{
		setTimeout(() =>
		{
			refreshEnumNode(node);
		}, 0);
		return;
	}

	const next_token = (node_refresh_tokens.get(node.id) || 0) + 1;
	node_refresh_tokens.set(node.id, next_token);

	const run_refresh = (remaining_attempts) =>
	{
		if (node_refresh_tokens.get(node.id) !== next_token)
		{
			return;
		}

		refreshEnumNode(node);

		if (remaining_attempts > 1)
		{
			setTimeout(() =>
			{
				run_refresh(remaining_attempts - 1);
			}, GRAPH_REFRESH_DELAY_MS);
		}
	};

	setTimeout(() =>
	{
		run_refresh(Math.max(1, attempts));
	}, 0);
}

function installLoadGraphHook()
{
	if (load_graph_hook_installed || typeof app?.loadGraphData !== "function")
	{
		return;
	}

	const original_load_graph_data = app.loadGraphData;
	app.loadGraphData = async function()
	{
		const graphData = arguments[0];
		const serializedState = buildSerializedEnumState(graphData);
		serialized_enum_definitions = serializedState.definitions;
		serialized_enum_choices = serializedState.choices;

		const result = await original_load_graph_data.apply(this, arguments);
		scheduleGraphRefresh();
		return result;
	};

	load_graph_hook_installed = true;
}

function installNodeHooks(nodeType)
{
	if (!isEnumNodeType(nodeType) || !nodeType?.prototype || nodeType.prototype.__enum_combo_hooks_installed)
	{
		return;
	}

	nodeType.prototype.__enum_combo_hooks_installed = true;

	const onNodeCreated = nodeType.prototype.onNodeCreated;
	nodeType.prototype.onNodeCreated = function()
	{
		const result = onNodeCreated?.apply(this, arguments);

		bindChoiceWidgetRefresh(this);
		bindSourceWidgetRefresh(this);

		const definitionWidget = getWidget(this, "enum_definition");
		if (definitionWidget && !definitionWidget.enumComboCallbackBound)
		{
			const originalCallback = definitionWidget.callback;
			definitionWidget.callback = (...args) =>
			{
				const result = originalCallback?.apply(this, args);
				refreshEnumChoices(this);
				return result;
			};
			definitionWidget.enumComboCallbackBound = true;
		}

		scheduleNodeRefresh(this);
		return result;
	};

	const onAdded = nodeType.prototype.onAdded;
	nodeType.prototype.onAdded = function()
	{
		const result = onAdded?.apply(this, arguments);
		scheduleNodeRefresh(this);
		return result;
	};

	const onConnectionsChange = nodeType.prototype.onConnectionsChange;
	nodeType.prototype.onConnectionsChange = function(type, slotIndex, isConnected, linkInfo, ioSlot)
	{
		onConnectionsChange?.apply(this, arguments);

		if (ioSlot?.name === "enum_definition" || this.inputs?.[slotIndex]?.name === "enum_definition")
		{
			if (!hasLinkedDefinitionInput(this))
			{
				delete this.enumComboCachedDefinition;
				serialized_enum_definitions.delete(this.id);
			}

			bindSourceWidgetRefresh(this);
			scheduleNodeRefresh(this);
		}
	};

	const onConfigure = nodeType.prototype.onConfigure;
	nodeType.prototype.onConfigure = function(info)
	{
		const result = onConfigure?.apply(this, arguments);

		bindChoiceWidgetRefresh(this);
		requestAnimationFrame(() =>
		{
			bindSourceWidgetRefresh(this);
			scheduleNodeRefresh(this);
		});

		return result;
	};

	const onRemoved = nodeType.prototype.onRemoved;
	nodeType.prototype.onRemoved = function()
	{
		clearSourceWidgetRefresh(this);
		return onRemoved?.apply(this, arguments);
	};
}

function installExistingNodeHooks()
{
	for (const nodeType of getRegisteredNodeTypes())
	{
		installNodeHooks(nodeType);
	}
}

function create_extension_definition()
{
	return {
		name: EXTENSION_NAME,

		async setup()
		{
			installLoadGraphHook();
			installExistingNodeHooks();
			scheduleGraphRefresh();
		},

		async beforeRegisterNodeDef(nodeType, nodeData)
		{
			if (NODE_NAMES.has(nodeData.name))
			{
				installNodeHooks(nodeType);
			}
		}
	};
}

app.registerExtension(create_extension_definition());
