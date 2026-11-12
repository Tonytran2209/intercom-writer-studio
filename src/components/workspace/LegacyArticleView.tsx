import { Archive, Copy, Download, ExternalLink } from "lucide-react"
import type { Article } from "../../types"
import { useI18n } from "../../lib/i18n"

interface Props {
  article: Article
  migrating: boolean
  onMigrate: () => void
}

export default function LegacyArticleView({ article, migrating, onMigrate }: Props) {
  const { tr } = useI18n()
  const draft = article.draft?.trim() ?? ""
  const copyDraft = () => draft && navigator.clipboard.writeText(draft)
  const downloadDraft = () => {
    if (!draft) return
    const url = URL.createObjectURL(new Blob([draft], { type: "text/plain;charset=utf-8" }))
    const link = document.createElement("a")
    link.href = url
    link.download = `${(article.title || article.topic || "legacy-article").replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.txt`
    link.click()
    URL.revokeObjectURL(url)
  }

  return (
    <main className="flex-1 min-h-0 overflow-y-auto px-4 py-7 md:px-8">
      <div className="mx-auto max-w-4xl space-y-8">
        <header className="border-b border-[#303030] pb-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <div className="mb-2 flex items-center gap-2 text-xs text-[#929292]">
                <Archive className="app-icon" aria-hidden="true" />
                {tr("Bản lưu trữ cũ · Chỉ đọc", "Legacy archive · Read only")}
              </div>
              <h1 className="text-2xl font-semibold leading-tight text-[#ededed]">{article.title || article.topic}</h1>
              <p className="mt-2 text-xs text-[#777]">{tr("Output gốc được hiển thị mà không áp dụng guard hoặc gọi AI mới.", "Original outputs are shown without applying current guards or calling AI.")}</p>
            </div>
            <button type="button" disabled={migrating} onClick={onMigrate} className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg border border-[#414141] bg-[#242424] px-3.5 py-2 ui-type-body font-medium text-[#e3e3e3] transition-colors hover:bg-[#2c2c2c] disabled:opacity-50">
              <ExternalLink className="app-icon" aria-hidden="true" />
              {migrating ? tr("Đang tạo bản mới…", "Creating copy…") : tr("Tạo bản workflow mới", "Create current-workflow copy")}
            </button>
          </div>
        </header>

        {!!article.coreIdeaSuggestions?.length && (
          <section>
            <h2 className="mb-3 text-sm font-medium text-[#d8d8d8]">Core ideas</h2>
            <div className="divide-y divide-[#303030] rounded-xl border border-[#303030] bg-[#1d1d1d]">
              {article.coreIdeaSuggestions.map((idea) => (
                <div key={idea.id} className="px-4 py-3">
                  <div className="text-sm font-medium text-[#e2e2e2]">{idea.title}</div>
                  <p className="mt-1 text-xs leading-5 text-[#909090]">{idea.angleDescription || idea.mainArgument}</p>
                </div>
              ))}
            </div>
          </section>
        )}

        {!!article.outline?.length && (
          <section>
            <h2 className="mb-3 text-sm font-medium text-[#d8d8d8]">Outline</h2>
            <div className="divide-y divide-[#303030] rounded-xl border border-[#303030] bg-[#1d1d1d]">
              {article.outline.map((section, index) => (
                <div key={section.id || index} className="flex gap-3 px-4 py-3">
                  <span className="w-7 shrink-0 text-xs text-[#666]">{index + 1}</span>
                  <div><div className="text-sm text-[#dedede]">{section.heading}</div>{section.notes && <p className="mt-1 text-xs leading-5 text-[#858585]">{section.notes}</p>}</div>
                </div>
              ))}
            </div>
          </section>
        )}

        <section>
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-sm font-medium text-[#d8d8d8]">First draft</h2>
            <div className="flex gap-1">
              <button disabled={!draft} onClick={copyDraft} className="sidebar-icon-button" aria-label={tr("Sao chép draft", "Copy draft")}><Copy className="app-icon" /></button>
              <button disabled={!draft} onClick={downloadDraft} className="sidebar-icon-button" aria-label={tr("Tải draft", "Download draft")}><Download className="app-icon" /></button>
            </div>
          </div>
          <div className="min-h-48 whitespace-pre-wrap rounded-xl border border-[#303030] bg-[#1d1d1d] px-5 py-5 text-[15px] leading-7 text-[#d6d6d6]">
            {draft || tr("Bản lưu trữ này không có draft.", "This archive has no saved draft.")}
          </div>
        </section>
      </div>
    </main>
  )
}
