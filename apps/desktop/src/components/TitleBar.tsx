export function TitleBar() {
  return (
    <header
      className="relative z-10 grid h-8 flex-[0_0_32px] grid-cols-[120px_1fr_120px] items-center border-b border-(--app-border-subtle) bg-(--app-surface-chrome) shadow-[0_1px_3px_var(--app-border-subtle)] select-none"
      data-tauri-drag-region
    >
      <div aria-hidden="true" className="h-full" />
      <div
        className="flex min-w-0 justify-center gap-2 items-center"
        data-tauri-drag-region
      >
        <span className="font-[Georgia,'Times_New_Roman',serif] text-[15px] tracking-[0.02em] text-(--app-text-strong)">
          Lysiptera Caliginia
        </span>
        <span className="font-[ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace] text-[9px] tracking-[0.18em] text-(--app-text-faint) uppercase">
          v1
        </span>
      </div>
    </header>
  )
}
