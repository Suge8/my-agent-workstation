/** 去掉行注释和块注释，字符串内的斜杠不动。不支持尾逗号。 */
export function parseJsonc(text: string): unknown {
	let output = "";
	let inString = false;
	let escape = false;
	for (let index = 0; index < text.length; index++) {
		const char = text[index];
		if (inString) {
			output += char;
			if (escape) escape = false;
			else if (char === "\\") escape = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') {
			inString = true;
			output += char;
			continue;
		}
		if (char === "/" && text[index + 1] === "/") {
			index += 1;
			while (index + 1 < text.length && text[index + 1] !== "\n") index += 1;
			continue;
		}
		if (char === "/" && text[index + 1] === "*") {
			index += 1;
			while (index + 1 < text.length && !(text[index] === "*" && text[index + 1] === "/")) index += 1;
			index += 1;
			continue;
		}
		output += char;
	}
	return JSON.parse(output);
}
