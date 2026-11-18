import assert from "node:assert/strict";
import test from "node:test";
import MarkdownIt from "markdown-it";
import { createMarkdownRenderer } from "./markdown.js";

const render = createMarkdownRenderer(MarkdownIt);
test("Markdown tables and nested lists render without loading remote images or raw HTML", () => {
	const html = render([
		"| A | B |", "| -- | -- |", "| one | two |", "",
		"- outer", "  - inner", "", "<img alt=raw>", "",
		"![a screenshot](https://example.com/img.png)", "", "[source](https://example.com)",
	].join("\n"));
	assert.match(html, /<table>/);
	assert.match(html, /<ul>[\s\S]*<ul>/);
	assert.match(html, /&lt;img/);
	assert.doesNotMatch(html, /<img/);
	assert.match(html, /rel="noopener noreferrer"/);
});
