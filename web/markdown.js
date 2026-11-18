// A small markdown renderer, just enough for what pi sends back.
//
// Deliberately hand-rolled: the app has to work with no network beyond the
// bridge, so pulling in a library is not an option. Everything is escaped
// before any tag is added, so model output can never inject HTML.

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

// ---------------------------------------------------------------- inline

function inline(s) {
	let t = esc(s);
	// Code spans come out first so nothing inside them is treated as markup. The
	// placeholder is a control character that cannot survive escaping, so it can
	// never collide with a plain number in the text.
	const spans = [];
	t = t.replace(/`([^`]+)`/g, (_, c) => {
		spans.push(c);
		return `\u0001${spans.length - 1}\u0001`;
	});
	t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
	t = t.replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>");
	t = t.replace(/(^|[\s(])_([^_\n]+)_/g, "$1<em>$2</em>");
	t = t.replace(/~~([^~]+)~~/g, "<del>$1</del>");
	t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
	t = t.replace(/\u0001(\d+)\u0001/g, (_, i) => `<code class="inline">${spans[Number(i)]}</code>`);
	return t;
}

// ---------------------------------------------------------------- blocks

/** Markdown to HTML. Unclosed code fences are rendered too, so a block that is
 *  still streaming in shows its contents rather than vanishing. */
export function markdown(src) {
	const lines = String(src ?? "").replace(/\r\n/g, "\n").split("\n");
	let html = "";
	let i = 0;
	let para = [];

	const flushPara = () => {
		if (para.length) {
			html += `<p>${inline(para.join("\n")).replace(/\n/g, "<br>")}</p>`;
			para = [];
		}
	};

	while (i < lines.length) {
		const line = lines[i];
		const fence = line.match(/^\s*```\s*([\w+-]*)\s*$/);

		if (fence) {
			flushPara();
			const lang = (fence[1] || "").toLowerCase();
			const body = [];
			i += 1;
			while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]);
			i += 1; // step past the closing fence, if there was one
			html += codeBlock(body.join("\n"), lang);
			continue;
		}

		if (/^\s*$/.test(line)) {
			flushPara();
			i += 1;
			continue;
		}

		const head = line.match(/^(#{1,3})\s+(.*)$/);
		if (head) {
			flushPara();
			html += `<h${head[1].length}>${inline(head[2])}</h${head[1].length}>`;
			i += 1;
			continue;
		}

		if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
			flushPara();
			html += "<hr>";
			i += 1;
			continue;
		}

		if (/^\s*>\s?/.test(line)) {
			flushPara();
			const body = [];
			while (i < lines.length && /^\s*>\s?/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ""));
			html += `<blockquote>${inline(body.join("\n")).replace(/\n/g, "<br>")}</blockquote>`;
			continue;
		}

		const bullet = /^\s*[-*+]\s+/;
		const numbered = /^\s*\d+[.)]\s+/;
		if (bullet.test(line) || numbered.test(line)) {
			flushPara();
			const ordered = numbered.test(line);
			const re = ordered ? numbered : bullet;
			const items = [];
			while (i < lines.length && re.test(lines[i])) {
				let item = lines[i++].replace(re, "");
				// keep plainly indented continuation lines with their bullet
				while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !re.test(lines[i])) item += "\n" + lines[i++].trim();
				items.push(`<li>${inline(item).replace(/\n/g, "<br>")}</li>`);
			}
			html += ordered ? `<ol>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`;
			continue;
		}

		para.push(line);
		i += 1;
	}

	flushPara();
	return html;
}
