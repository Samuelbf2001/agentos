/** Markdown con GFM + resaltado shiki (lazy) para código y diffs. */
import { useEffect, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

let shikiPromise: Promise<typeof import("shiki")> | null = null;
function loadShiki() {
  shikiPromise ??= import("shiki");
  return shikiPromise;
}

const KNOWN_LANGS = new Set([
  "diff",
  "json",
  "ts",
  "tsx",
  "js",
  "jsx",
  "typescript",
  "javascript",
  "bash",
  "shell",
  "sql",
  "yaml",
  "markdown",
  "md",
  "html",
  "css",
  "python",
]);

export function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const language = lang && KNOWN_LANGS.has(lang) ? lang : "text";
    loadShiki()
      .then(({ codeToHtml }) =>
        codeToHtml(code, { lang: language, theme: "github-light" }),
      )
      .then((out) => {
        if (alive) setHtml(out);
      })
      .catch(() => {
        /* fallback: <pre> plano */
      });
    return () => {
      alive = false;
    };
  }, [code, lang]);
  if (html) {
    return <div className="my-2 text-xs" dangerouslySetInnerHTML={{ __html: html }} />;
  }
  return (
    <pre className="my-2 overflow-x-auto rounded-md bg-slate-100 p-3 text-xs leading-relaxed">
      <code>{code}</code>
    </pre>
  );
}

export function Markdown({ children }: { children: string }) {
  return (
    <div className="prose-sm max-w-none [&_a]:text-sky-700 [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-slate-300 [&_blockquote]:pl-3 [&_blockquote]:text-slate-500 [&_code]:rounded [&_code]:bg-slate-100 [&_code]:px-1 [&_code]:text-[0.85em] [&_h1]:mt-3 [&_h1]:text-lg [&_h1]:font-bold [&_h2]:mt-3 [&_h2]:text-base [&_h2]:font-bold [&_h3]:mt-2 [&_h3]:text-sm [&_h3]:font-semibold [&_li]:ml-4 [&_ol]:list-decimal [&_p]:my-1.5 [&_table]:my-2 [&_table]:text-xs [&_td]:border [&_td]:border-slate-200 [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-slate-200 [&_th]:bg-slate-50 [&_th]:px-2 [&_th]:py-1 [&_ul]:list-disc">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code(props) {
            const { className, children: kids } = props;
            const match = /language-(\w+)/.exec(className ?? "");
            const text = String(kids ?? "");
            if (match || text.includes("\n")) {
              return <CodeBlock code={text.replace(/\n$/, "")} lang={match?.[1]} />;
            }
            return <code className={className}>{kids as ReactNode}</code>;
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
