import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Model text is content: raw HTML and remote images are never executed or loaded. */
export function AnalysisMarkdown({ children }: { children: string }) {
  return (
    <div className="analysis-markdown">
      <Markdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        disallowedElements={["img"]}
        urlTransform={(url) => (/^https?:\/\//i.test(url) ? url : "")}
        components={{
          a: ({ children, href }) =>
            href ? (
              <a href={href} target="_blank" rel="noreferrer">
                {children}
              </a>
            ) : (
              <span>{children}</span>
            ),
        }}
      >
        {children}
      </Markdown>
    </div>
  );
}
