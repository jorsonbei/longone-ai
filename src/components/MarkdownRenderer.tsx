import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { Copy, Check } from 'lucide-react';
import { useState } from 'react';

export function MarkdownRenderer({ content }: { content: string }) {
  return (
    <div className="prose prose-neutral dark:prose-invert max-w-none break-words">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
      components={{
        code({ node, inline, className, children, ...props }: any) {
          const match = /language-(\w+)/.exec(className || '');
          const isInline = inline || !match?.[1];

          if (isInline) {
            return (
              <code
                className="rounded border border-white/10 px-[0.28rem] py-[0.12rem] font-mono text-[0.92em] text-slate-200"
                {...props}
              >
                {children}
              </code>
            );
          }

          return (
            <CodeBlock language={match?.[1]} value={String(children).replace(/\n$/, '')} />
          );
        },
        // Better styling for tables
        table({ children }) {
          return (
            <div className="overflow-x-auto my-4 w-full rounded-md border border-border">
              <table className="w-full text-sm text-left table-auto">
                {children}
              </table>
            </div>
          );
        },
        th({ children }) {
          return <th className="bg-muted/50 px-4 py-3 font-semibold text-foreground border-b border-border">{children}</th>;
        },
        td({ children }) {
          return <td className="px-4 py-3 border-b border-border/50 last:border-0">{children}</td>;
        },
        a({ children, href }) {
          return <a href={href} className="text-primary underline underline-offset-4 hover:opacity-80" target="_blank" rel="noreferrer">{children}</a>
        }
      }}
    >
      {content}
    </ReactMarkdown>
    </div>
  );
}

function CodeBlock({ language, value }: { language: string; value: string }) {
  const [isCopied, setIsCopied] = useState(false);

  const copyToClipboard = () => {
    navigator.clipboard.writeText(value);
    setIsCopied(true);
    setTimeout(() => setIsCopied(false), 2000);
  };

  return (
    <div className="relative my-4 rounded-md overflow-hidden bg-[#1E1E1E] border border-border group">
      <div className="flex items-center justify-between px-4 py-2 bg-black/40 text-xs text-muted-foreground border-b border-white/10">
        <span className="font-mono lowercase">{language || 'text'}</span>
        <button
          onClick={copyToClipboard}
          className="flex items-center gap-1.5 hover:text-foreground transition-colors"
          title="Copy code"
        >
          {isCopied ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />}
          {isCopied ? 'Copied!' : 'Copy'}
        </button>
      </div>
      <div className="text-[13px] md:text-sm">
        <SyntaxHighlighter
          language={language || 'text'}
          style={vscDarkPlus}
          customStyle={{
            margin: 0,
            padding: '1rem',
            background: 'transparent',
          }}
          codeTagProps={{
            style: { fontFamily: "var(--font-mono)", fontSize: "inherit" },
          }}
        >
          {value}
        </SyntaxHighlighter>
      </div>
    </div>
  );
}
