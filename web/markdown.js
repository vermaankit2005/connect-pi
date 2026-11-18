// Offline Markdown rendering with HTML disabled and local code highlighting.

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

// ---------------------------------------------------------------- code

const KEYWORDS =
	"await|async|break|case|catch|class|const|continue|def|default|delete|elif|else|except|export|extends|finally|for|from|function|if|import|in|instanceof|interface|is|lambda|let|new|not|or|and|pass|raise|return|self|super|switch|this|throw|try|type|typeof|var|void|while|with|yield|True|False|None|null|true|false|undefined|print|echo|fn|pub|use|struct|impl|match|mut";

/**
 * Rough syntax colouring for real code. It is a single pass over the text so a
 * match inside a string or comment cannot be re-coloured afterwards, which is
 * what makes a naive regex highlighter fall apart.
 */
function highlightCode(code) {
	const pattern = new RegExp(
		[
			"(#[^\\n]*|//[^\\n]*|/\\*[\\s\\S]*?\\*/)", // comments
			"(\"\"\"[\\s\\S]*?\"\"\"|'''[\\s\\S]*?'''|`[^`]*`|\"(?:\\\\.|[^\"\\\\])*\"|'(?:\\\\.|[^'\\\\])*')", // strings
			"\\b(" + KEYWORDS + ")\\b", // keywords
			"\\b(\\d+(?:\\.\\d+)?)\\b", // numbers
			"\\b([A-Za-z_][\\w]*)(?=\\()", // call sites
		].join("|"),
		"g",
	);

	let out = "";
	let last = 0;
	for (const m of code.matchAll(pattern)) {
		out += esc(code.slice(last, m.index));
		if (m[1]) out += `<span class="tok-com">${esc(m[1])}</span>`;
		else if (m[2]) out += `<span class="tok-str">${esc(m[2])}</span>`;
		else if (m[3]) out += `<span class="tok-key">${esc(m[3])}</span>`;
		else if (m[4]) out += `<span class="tok-num">${esc(m[4])}</span>`;
		else if (m[5]) out += `<span class="tok-fn">${esc(m[5])}</span>`;
		last = m.index + m[0].length;
	}
	return out + esc(code.slice(last));
}

// ------------------------------------------------------------ markdown card

/**
 * Colouring for a block of *markdown source*, shown as-is.
 *
 * This is not the same job as rendering markdown. When pi shows you the
 * contents of a .md file you want to see the file — the hashes, the asterisks,
 * the dashes — just tinted so it reads. Running the code highlighter over it
 * was the old bug: "#" started a comment and swallowed the whole heading, and
 * ordinary English words like "for" and "in" came out purple.
 */
function highlightMarkdownInline(line) {
	// The order matters: code spans are matched first so nothing inside them is
	// re-coloured, then links, then bold before italic (** before *).
	const pattern =
		/(`[^`\n]*`)|(\*\*[^*\n]+\*\*|__[^_\n]+__)|(\*[^*\n]+\*|_[^_\n]+_)|(!?\[[^\]\n]*\]\([^)\n]*\))|(~~[^~\n]+~~)|(https?:\/\/[^\s)]+)/g;

	let out = "";
	let last = 0;
	for (const m of line.matchAll(pattern)) {
		out += esc(line.slice(last, m.index));
		if (m[1]) out += `<span class="md-code">${esc(m[1])}</span>`;
		else if (m[2]) out += `<span class="md-strong">${esc(m[2])}</span>`;
		else if (m[3]) out += `<span class="md-em">${esc(m[3])}</span>`;
		else if (m[4]) out += `<span class="md-link">${esc(m[4])}</span>`;
		else if (m[5]) out += `<span class="md-del">${esc(m[5])}</span>`;
		else if (m[6]) out += `<span class="md-link">${esc(m[6])}</span>`;
		last = m.index + m[0].length;
	}
	return out + esc(line.slice(last));
}

function highlightMarkdown(src) {
	const mark = (s) => `<span class="md-mark">${esc(s)}</span>`;
	let inFence = false;

	return String(src)
		.split("\n")
		.map((line) => {
			const fence = line.match(/^(\s*)(```|~~~)(.*)$/);
			if (fence) {
				inFence = !inFence;
				return esc(fence[1]) + mark(fence[2]) + `<span class="md-mark">${esc(fence[3])}</span>`;
			}
			// a fenced block inside the file stays plain — it is code, not prose
			if (inFence) return esc(line);

			const heading = line.match(/^(\s*)(#{1,6})(\s+)(.*)$/);
			if (heading) {
				return (
					esc(heading[1]) +
					mark(heading[2]) +
					esc(heading[3]) +
					`<span class="md-head">${highlightMarkdownInline(heading[4])}</span>`
				);
			}

			if (/^\s*(([-*_])\s*){3,}\s*$/.test(line)) return mark(line);

			const quote = line.match(/^(\s*>+\s?)(.*)$/);
			if (quote) return mark(quote[1]) + `<span class="md-quote">${highlightMarkdownInline(quote[2])}</span>`;

			const bullet = line.match(/^(\s*)([-*+]|\d+[.)])(\s+)(.*)$/);
			if (bullet) {
				return esc(bullet[1]) + mark(bullet[2]) + esc(bullet[3]) + highlightMarkdownInline(bullet[4]);
			}

			// a table row: tint the pipes so the columns stand out
			if (/^\s*\|.*\|\s*$/.test(line)) {
				return line
					.split("|")
					.map((cell) => highlightMarkdownInline(cell))
					.join(mark("|"));
			}

			return highlightMarkdownInline(line);
		})
		.join("\n");
}

// ---------------------------------------------------------------- the card

// Languages that are prose or plain data, not code — the keyword highlighter
// would only make a mess of them.
const MARKDOWN_LANGS = new Set(["md", "markdown", "mdown", "mkd", "mdx"]);
const PLAIN_LANGS = new Set(["", "text", "txt", "plain", "log", "output", "csv", "env", "ini", "conf"]);

/**
 * One fenced block, as its own card. `lang` decides how it is coloured:
 * markdown source gets the markdown tints, plain text gets none, everything
 * else goes through the code highlighter.
 */
export function codeBlock(code, lang = "") {
	const kind = String(lang || "").toLowerCase();
	let body;
	if (MARKDOWN_LANGS.has(kind)) body = highlightMarkdown(code);
	else if (PLAIN_LANGS.has(kind)) body = esc(code);
	else body = highlightCode(code);

	// The card carries the fence's language so the copy button and the tints can
	// differ per kind, and so a markdown card reads as a document, not as code.
	return (
		`<div class="code${MARKDOWN_LANGS.has(kind) ? " code-md" : ""}" data-code="${esc(code)}">` +
		`<button class="code-copy" aria-label="Copy code"><svg class="ic ic-18"><use href="#i-copy"/></svg></button>` +
		`<pre><code>${body}</code></pre></div>`
	);
}

export function createMarkdownRenderer(MarkdownIt) {
	const md = new MarkdownIt({ html: false, breaks: true, maxNesting: 20 });
	md.renderer.rules.fence = (tokens, i) => {
		const token = tokens[i];
		return codeBlock(token.content.replace(/\n$/, ""), token.info.trim().split(/\s+/)[0] || "");
	};
	md.renderer.rules.image = (tokens, i) => `<span class="notice">[Image: ${esc(tokens[i].content || "external image")}]</span>`;
	md.renderer.rules.link_open = (tokens, i, options, env, renderer) => {
		tokens[i].attrSet("target", "_blank");
		tokens[i].attrSet("rel", "noopener noreferrer");
		return renderer.renderToken(tokens, i, options);
	};
	return (value) => md.render(String(value ?? ""));
}

let render;
export function markdown(value) {
	if (!globalThis.markdownit) return esc(value);
	render ||= createMarkdownRenderer(globalThis.markdownit);
	return render(value);
}
