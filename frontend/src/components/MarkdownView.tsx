import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { cn } from '@/lib/utils'

/** Renders a Markdown string with GitHub-flavored extensions (tables, etc.).
 *
 *  The app has no @tailwindcss/typography plugin, so `prose` classes are inert —
 *  this carries its own Tailwind class map per element instead. Used by the run
 *  inspector to show converted deliverables (SPA-71); reusable elsewhere. */
const components: Components = {
  h1: ({ children }) => <h1 className="text-base font-semibold mt-3 mb-1">{children}</h1>,
  h2: ({ children }) => <h2 className="text-sm font-semibold mt-3 mb-1">{children}</h2>,
  h3: ({ children }) => <h3 className="text-sm font-medium mt-2 mb-1">{children}</h3>,
  p: ({ children }) => <p className="my-1 leading-relaxed">{children}</p>,
  ul: ({ children }) => <ul className="list-disc pl-5 my-1 space-y-0.5">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal pl-5 my-1 space-y-0.5">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">
      {children}
    </a>
  ),
  table: ({ children }) => (
    <div className="overflow-x-auto my-2">
      <table className="border-collapse text-xs">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-gray-50">{children}</thead>,
  th: ({ children }) => (
    <th className="border border-gray-200 px-2 py-1 text-left font-medium">{children}</th>
  ),
  td: ({ children }) => <td className="border border-gray-200 px-2 py-1 align-top">{children}</td>,
  code: ({ children }) => (
    <code className="rounded bg-gray-100 px-1 py-0.5 text-[11px] font-mono">{children}</code>
  ),
  pre: ({ children }) => (
    <pre className="bg-gray-50 rounded p-2 overflow-x-auto text-[11px] font-mono my-2">
      {children}
    </pre>
  ),
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-gray-200 pl-3 text-gray-500 my-1">
      {children}
    </blockquote>
  ),
}

export default function MarkdownView({
  children,
  className,
}: {
  children: string
  className?: string
}) {
  return (
    <div className={cn('text-xs text-gray-700 break-words', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  )
}
