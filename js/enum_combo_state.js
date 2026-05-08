import {
	STRING_WIDGET_NAMES,
	getGraphLink,
	getNodeWidgets,
	getSourceNodeForInput,
	getWidget,
	parseEnumNames,
} from "./enum_combo_shared.js";

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

	const serialized_string_values = widgetValues.filter((value) => typeof value === "string");
	if (serialized_string_values.length === 1)
	{
		return serialized_string_values[0];
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

export function buildSerializedEnumState(graphData, nodeNames)
{
	const definitions = new Map();
	const choices = new Map();
	const nodes = Array.isArray(graphData?.nodes) ? graphData.nodes : [];

	for (const nodeData of nodes)
	{
		if (!nodeNames.has(nodeData?.type))
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

function getCachedDefinitionValue(node, serializedEnumDefinitions)
{
	if (typeof node?.enumComboCachedDefinition === "string")
	{
		return node.enumComboCachedDefinition;
	}

	if (!hasLinkedDefinitionInput(node))
	{
		return null;
	}

	const serializedDefinition = serializedEnumDefinitions.get(node?.id);
	return typeof serializedDefinition === "string" ? serializedDefinition : null;
}

export function getPreferredChoiceValue(node, widget, availableValues, serializedEnumChoices)
{
	const candidateValues = [
		widget?.value,
		node?.enumComboCachedChoice,
		serializedEnumChoices.get(node?.id),
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

function getStringWidgets(node)
{
	return getNodeWidgets(node).filter((widget) => typeof widget?.value === "string");
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

export function hasLinkedDefinitionInput(node)
{
	return node.inputs?.some((input) => input?.name === "enum_definition" && input.link != null) === true;
}

export function collectDefinitionWidgets(enumNode)
{
	const widgets = new Set();

	if (hasLinkedDefinitionInput(enumNode))
	{
		const sourceNode = getSourceNodeForInput(enumNode, "enum_definition");
		const stringNodes = collectLinkedStringNodes(sourceNode);

		for (const stringNode of stringNodes)
		{
			for (const widget of getStringWidgets(stringNode))
			{
				widgets.add(widget);
			}
		}

		return widgets;
	}

	const definitionWidget = getWidget(enumNode, "enum_definition");
	if (typeof definitionWidget?.value === "string")
	{
		widgets.add(definitionWidget);
	}

	return widgets;
}

export function getDefinitionValue(node, serializedEnumDefinitions)
{
	const sourceNode = getSourceNodeForInput(node, "enum_definition");
	const linkedValue = getLinkedStringValue(sourceNode);

	if (linkedValue !== null)
	{
		node.enumComboCachedDefinition = linkedValue;
		return linkedValue;
	}

	const cachedDefinition = getCachedDefinitionValue(node, serializedEnumDefinitions);
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

export function getCurrentChoiceValues(node, serializedEnumDefinitions)
{
	return parseEnumNames(getDefinitionValue(node, serializedEnumDefinitions));
}
