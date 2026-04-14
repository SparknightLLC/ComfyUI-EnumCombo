import re

from dataclasses import dataclass
from typing import Optional


DEFAULT_ENUM_DEFINITION = """OPTION_A
OPTION_B"""
DEFAULT_CHOICES = ["OPTION_A", "OPTION_B"]
INT_MIN = -0xffffffffffffffff
INT_MAX = 0xffffffffffffffff

ENUM_DEFINITION_TOOLTIP = (
	"One enum member per line. Use NAME or NAME = integer. "
	"Unassigned values auto-increment from start or the previous explicit value. "
	"Quote labels that contain spaces. Supports #, //, and /* */ comments."
)
LINKED_ENUM_DEFINITION_TOOLTIP = (
	"Connect a STRING node containing one enum member per line. "
	"The compact node refreshes its choice dropdown when this link changes and before the choice dropdown opens. "
	"Use Enum Combo Advanced if you want to edit the definition directly inside the enum node."
)
CHOICE_TOOLTIP = "The enum member to select. The dropdown updates from enum_definition."
START_TOOLTIP = "The integer value used for the first unassigned member."
STRICT_TOOLTIP = "If enabled, execution errors when the saved choice is not present in enum_definition."

IDENTIFIER_PATTERN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


@dataclass(frozen=True)
class EnumMember:
	name: str
	value: int
	index: int


def _strip_comments(text: str) -> str:
	result = []
	index = 0
	in_block_comment = False
	quote_char: Optional[str] = None
	escaped = False

	while index < len(text):
		char = text[index]
		next_char = text[index + 1] if index + 1 < len(text) else ""

		if in_block_comment:
			if char == "*" and next_char == "/":
				in_block_comment = False
				index += 2
				continue
			if char == "\n":
				result.append("\n")
			index += 1
			continue

		if quote_char is not None:
			result.append(char)
			if escaped:
				escaped = False
			elif char == "\\":
				escaped = True
			elif char == quote_char:
				quote_char = None
			index += 1
			continue

		if char in ("\"", "'"):
			quote_char = char
			result.append(char)
			index += 1
			continue

		if char == "/" and next_char == "*":
			in_block_comment = True
			index += 2
			continue

		if char == "/" and next_char == "/":
			while index < len(text) and text[index] != "\n":
				index += 1
			continue

		if char == "#":
			while index < len(text) and text[index] != "\n":
				index += 1
			continue

		result.append(char)
		index += 1

	if in_block_comment:
		raise ValueError("Unclosed block comment in enum definition.")

	if quote_char is not None:
		raise ValueError("Unclosed quoted enum name in enum definition.")

	return "".join(result)


def _strip_line_terminator(line: str) -> str:
	line = line.strip()
	while line.endswith(",") or line.endswith(";"):
		line = line[:-1].strip()
	return line


def _read_quoted_name(line: str, line_number: int) -> tuple[str, str]:
	quote_char = line[0]
	index = 1
	escaped = False
	chars = []

	while index < len(line):
		char = line[index]
		if escaped:
			if char == "n":
				chars.append("\n")
			elif char == "t":
				chars.append("\t")
			else:
				chars.append(char)
			escaped = False
		elif char == "\\":
			escaped = True
		elif char == quote_char:
			return ("".join(chars), line[index + 1:].strip())
		else:
			chars.append(char)
		index += 1

	raise ValueError(f"Line {line_number}: unclosed quoted enum name.")


def _parse_enum_line(line: str, line_number: int) -> tuple[str, Optional[int]]:
	line = _strip_line_terminator(line)
	if not line:
		raise ValueError(f"Line {line_number}: enum member is empty.")

	if line[0] in ("\"", "'"):
		name, remainder = _read_quoted_name(line, line_number)
	else:
		if "=" in line:
			name, remainder = line.split("=", 1)
			name = name.strip()
			remainder = f"= {remainder.strip()}"
		else:
			name = line.strip()
			remainder = ""

		if not IDENTIFIER_PATTERN.match(name):
			raise ValueError(
				f"Line {line_number}: invalid enum identifier \"{name}\". "
				"Use letters, numbers, and underscores, or quote labels that need spaces."
			)

	if not name:
		raise ValueError(f"Line {line_number}: enum name cannot be empty.")

	if not remainder:
		return (name, None)

	if not remainder.startswith("="):
		raise ValueError(f"Line {line_number}: expected '=' after enum name.")

	value_text = _strip_line_terminator(remainder[1:].strip())
	if not value_text:
		raise ValueError(f"Line {line_number}: missing integer value after '='.")

	try:
		value = int(value_text, 0)
	except ValueError as error:
		raise ValueError(f"Line {line_number}: \"{value_text}\" is not a valid integer.") from error

	return (name, value)


def parse_enum_definition(enum_definition: str, start: int = 0) -> list[EnumMember]:
	commentless_definition = _strip_comments(enum_definition or "")
	members = []
	seen_names = set()
	next_value = int(start)

	for line_number, raw_line in enumerate(commentless_definition.splitlines(), start=1):
		line = raw_line.strip()
		if not line:
			continue

		name, explicit_value = _parse_enum_line(line, line_number)
		if name in seen_names:
			raise ValueError(f"Line {line_number}: duplicate enum name \"{name}\".")

		if explicit_value is not None:
			next_value = explicit_value

		members.append(EnumMember(name=name, value=next_value, index=len(members)))
		seen_names.add(name)
		next_value += 1

	if not members:
		raise ValueError("Enum definition must contain at least one member.")

	return members


class EnumComboAdvanced:
	@classmethod
	def INPUT_TYPES(cls):
		return {
			"required": {
				"choice": (DEFAULT_CHOICES, {"default": "OPTION_A", "tooltip": CHOICE_TOOLTIP}),
				"start": ("INT", {"default": 0, "min": INT_MIN, "max": INT_MAX, "tooltip": START_TOOLTIP}),
				"strict": ("BOOLEAN", {"default": True, "tooltip": STRICT_TOOLTIP}),
				"enum_definition": (
					"STRING",
					{
						"default": DEFAULT_ENUM_DEFINITION,
						"multiline": True,
						"tooltip": ENUM_DEFINITION_TOOLTIP,
					},
				),
			},
		}

	RETURN_TYPES = ("INT", "STRING", "INT", "INT")
	RETURN_NAMES = ("value", "name", "index", "count")
	OUTPUT_TOOLTIPS = (
		"INT: The selected enum member's integer value.",
		"STRING: The selected enum member's name.",
		"INT: The selected enum member's zero-based position in the definition.",
		"INT: The number of enum members in the definition.",
	)
	FUNCTION = "select"
	CATEGORY = "utils/enum"
	DESCRIPTION = "Advanced workflow-local enum selector. Supports NAME and NAME = integer lines, with #, //, and /* */ comments."

	def select(self, enum_definition: str, choice: str, start: int, strict: bool):
		members = parse_enum_definition(enum_definition, start)
		selected_member = next((member for member in members if member.name == choice), None)

		if selected_member is None:
			if strict:
				available_names = ", ".join(member.name for member in members)
				raise ValueError(f"Enum choice \"{choice}\" is not defined. Available choices: {available_names}")
			selected_member = members[0]

		return (selected_member.value, selected_member.name, selected_member.index, len(members))

	@classmethod
	def VALIDATE_INPUTS(cls, **kwargs):
		return True

	@classmethod
	def IS_CHANGED(cls, enum_definition: str, choice: str, start: int, strict: bool):
		return (enum_definition, choice, start, strict)


class EnumCombo:
	@classmethod
	def INPUT_TYPES(cls):
		return {
			"required": {
				"choice": (DEFAULT_CHOICES, {"default": "OPTION_A", "tooltip": CHOICE_TOOLTIP}),
				"enum_definition": (
					"STRING",
					{
						"default": DEFAULT_ENUM_DEFINITION,
						"forceInput": True,
						"multiline": True,
						"tooltip": LINKED_ENUM_DEFINITION_TOOLTIP,
					},
				),
			},
		}

	RETURN_TYPES = ("INT",)
	RETURN_NAMES = ("value",)
	OUTPUT_TOOLTIPS = ("INT: The selected enum member's integer value.",)
	FUNCTION = "select"
	CATEGORY = "utils/enum"
	DESCRIPTION = "Compact workflow-local enum selector with one INT output."

	def select(self, enum_definition: str, choice: str):
		members = parse_enum_definition(enum_definition)
		selected_member = next((member for member in members if member.name == choice), None)

		if selected_member is None:
			available_names = ", ".join(member.name for member in members)
			raise ValueError(f"Enum choice \"{choice}\" is not defined. Available choices: {available_names}")

		return (selected_member.value,)

	@classmethod
	def VALIDATE_INPUTS(cls, **kwargs):
		return True

	@classmethod
	def IS_CHANGED(cls, enum_definition: str, choice: str):
		return (enum_definition, choice)


NODE_CLASS_MAPPINGS = {
	"EnumCombo": EnumCombo,
	"EnumComboAdvanced": EnumComboAdvanced,
}

NODE_DISPLAY_NAME_MAPPINGS = {
	"EnumCombo": "Enum Combo",
	"EnumComboAdvanced": "Enum Combo Advanced",
}
