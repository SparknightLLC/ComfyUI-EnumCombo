import { app } from "/scripts/app.js";
import {
	FALLBACK_CHOICES,
	NODE_NAMES,
	cloneValues,
	getRegisteredNodeTypes,
	getWidget,
	getWidgetValues,
	isEnumNode,
	isEnumNodeType,
	parseEnumNames,
	setWidgetOptionValues,
} from "./enum_combo_shared.js";
import {
	buildSerializedEnumState,
	collectDefinitionWidgets,
	getCurrentChoiceValues,
	getDefinitionValue,
	getPreferredChoiceValue,
	hasLinkedDefinitionInput,
} from "./enum_combo_state.js";

const EXTENSION_NAME = "EnumCombo.DynamicChoices";
const GRAPH_REFRESH_ATTEMPTS = 6;
const NODE_REFRESH_ATTEMPTS = 8;
const GRAPH_REFRESH_DELAY_MS = 75;

let graph_refresh_token = 0;
let load_graph_hook_installed = false;
let serialized_enum_definitions = new Map();
let serialized_enum_choices = new Map();
const node_refresh_tokens = new Map();

function bindSourceWidgetRefresh(enumNode)
{
	clearSourceWidgetRefresh(enumNode);

	const sourceWidgets = collectDefinitionWidgets(enumNode);
	for (const widget of sourceWidgets)
	{
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
		const preferredValue = getPreferredChoiceValue(node, widget, nextValues, serialized_enum_choices);

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

		if (!nextValues.includes(widget.value) && widget.value !== nextValues[0])
		{
			widget.value = nextValues[0];
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
	const values = getCurrentChoiceValues(node, serialized_enum_definitions);
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

	const values = getCurrentChoiceValues(node, serialized_enum_definitions);
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
		const enumDefinition = getDefinitionValue(node, serialized_enum_definitions);

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
		const values = getCurrentChoiceValues(targetNode, serialized_enum_definitions);
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
		const values = getCurrentChoiceValues(targetNode, serialized_enum_definitions);
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
		const serializedState = buildSerializedEnumState(graphData, NODE_NAMES);
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
