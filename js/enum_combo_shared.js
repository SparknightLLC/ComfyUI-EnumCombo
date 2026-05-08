export const NODE_NAMES = new Set(["EnumCombo", "EnumComboAdvanced"]);
export const FALLBACK_CHOICES = ["OPTION_A", "OPTION_B"];
export const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const STRING_WIDGET_NAMES = ["enum_definition", "text", "string", "value"];

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

export function parseEnumNames(enumDefinition)
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

export function getNodeWidgets(node)
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

export function getWidget(node, name)
{
	const widgets = getNodeWidgets(node);
	return widgets.find((widget) => widget.name === name);
}

export function getEnumNodeName(target)
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

export function isEnumNode(node)
{
	return getEnumNodeName(node) !== null;
}

export function isEnumNodeType(nodeType)
{
	return getEnumNodeName(nodeType) !== null;
}

export function getRegisteredNodeTypes()
{
	const registered_node_types = globalThis?.LiteGraph?.registered_node_types;
	return registered_node_types && typeof registered_node_types === "object"
		? Object.values(registered_node_types)
		: [];
}

export function getWidgetValues(widget)
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

export function cloneValues(values)
{
	return Array.isArray(values) ? values.slice() : [];
}

export function setWidgetOptionValues(widget, nextOptionValues)
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

export function getGraphLink(graph, linkId)
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

export function getSourceNodeForInput(node, inputName)
{
	const input = node.inputs?.find((item) => item.name === inputName);
	const link = getGraphLink(node.graph, input?.link);

	if (!link)
	{
		return null;
	}

	return node.graph?.getNodeById?.(link.origin_id) || null;
}
