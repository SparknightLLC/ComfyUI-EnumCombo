import { app } from "../../scripts/app.js";

const NODE_NAMES = new Set(["EnumCombo", "EnumComboAdvanced"]);
const FALLBACK_CHOICES = ["OPTION_A", "OPTION_B"];
const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const STRING_WIDGET_NAMES = ["enum_definition", "text", "string", "value"];

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
	return node.widgets?.find((widget) => widget.name === name);
}

function getGraphLink(graph, linkId)
{
	if (!graph || linkId == null)
	{
		return null;
	}

	const directLink = graph.links?.[linkId];
	if (directLink && (directLink.id === linkId || directLink.origin_id !== undefined))
	{
		return directLink;
	}

	if (Array.isArray(graph.links))
	{
		return graph.links.find((link) => link && link.id === linkId) || null;
	}

	return graph.links?.[linkId] || null;
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

function getStringWidgetValue(node)
{
	if (!node?.widgets)
	{
		return null;
	}

	for (const name of STRING_WIDGET_NAMES)
	{
		const widget = getWidget(node, name);
		if (typeof widget?.value === "string")
		{
			return widget.value;
		}
	}

	const stringWidget = node.widgets.find((widget) => typeof widget?.value === "string");
	return stringWidget?.value ?? null;
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
		return linkedValue;
	}

	const definitionWidget = getWidget(node, "enum_definition");
	if (definitionWidget)
	{
		return definitionWidget.value;
	}

	return null;
}

function bindSourceWidgetRefresh(enumNode)
{
	const sourceNode = getSourceNodeForInput(enumNode, "enum_definition");
	const stringNodes = collectLinkedStringNodes(sourceNode);

	for (const stringNode of stringNodes)
	{
		for (const widget of stringNode.widgets || [])
		{
			if (typeof widget?.value !== "string")
			{
				continue;
			}

			if (!widget.enumComboSubscribers)
			{
				widget.enumComboSubscribers = new Set();
				const originalCallback = widget.callback;

				widget.callback = function()
				{
					const result = originalCallback?.apply(this, arguments);

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
			}

			widget.enumComboSubscribers.add(enumNode);
		}
	}
}

function setComboValues(widget, values)
{
	widget.options = widget.options || {};
	widget.options.values = values;

	if (!values.includes(widget.value))
	{
		widget.value = values[0];
	}
}

function refreshEnumChoices(node)
{
	const choiceWidget = getWidget(node, "choice");
	const enumDefinition = getDefinitionValue(node);

	if (!choiceWidget)
	{
		return;
	}

	const names = parseEnumNames(enumDefinition);
	const currentValues = choiceWidget.options?.values || [];
	const valuesChanged = JSON.stringify(names) !== JSON.stringify(currentValues);
	const valueChanged = !names.includes(choiceWidget.value);

	if (valuesChanged || valueChanged)
	{
		setComboValues(choiceWidget, names);
		node.graph?.setDirtyCanvas?.(true, true);
	}
}

function bindChoiceWidgetRefresh(node)
{
	const choiceWidget = getWidget(node, "choice");

	if (!choiceWidget || choiceWidget.enumComboRefreshBound)
	{
		return;
	}

	const originalMouse = choiceWidget.mouse;
	choiceWidget.mouse = function(event, pos, nodeInstance)
	{
		refreshEnumChoices(nodeInstance || node);

		if (originalMouse)
		{
			return originalMouse.apply(this, arguments);
		}

		return false;
	};

	choiceWidget.enumComboRefreshBound = true;
}

app.registerExtension(
{
	name: "EnumCombo.DynamicChoices",

	async beforeRegisterNodeDef(nodeType, nodeData)
	{
		if (!NODE_NAMES.has(nodeData.name))
		{
			return;
		}

		const onNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function()
		{
			onNodeCreated?.apply(this, arguments);
			bindChoiceWidgetRefresh(this);
			bindSourceWidgetRefresh(this);

			const definitionWidget = getWidget(this, "enum_definition");
			if (definitionWidget)
			{
				const originalCallback = definitionWidget.callback;
				definitionWidget.callback = (...args) =>
				{
					const result = originalCallback?.apply(this, args);
					refreshEnumChoices(this);
					return result;
				};
			}

			refreshEnumChoices(this);
		};

		const onAdded = nodeType.prototype.onAdded;
		nodeType.prototype.onAdded = function()
		{
			onAdded?.apply(this, arguments);
			refreshEnumChoices(this);
		};

		const onConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function(type, slotIndex, isConnected, linkInfo, ioSlot)
		{
			onConnectionsChange?.apply(this, arguments);

			if (ioSlot?.name === "enum_definition" || this.inputs?.[slotIndex]?.name === "enum_definition")
			{
				bindSourceWidgetRefresh(this);
				refreshEnumChoices(this);
			}
		};

		const onConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function(info)
		{
			onConfigure?.apply(this, arguments);
			bindChoiceWidgetRefresh(this);
			requestAnimationFrame(() =>
			{
				bindSourceWidgetRefresh(this);
				refreshEnumChoices(this);
			});
		};
	}
});
