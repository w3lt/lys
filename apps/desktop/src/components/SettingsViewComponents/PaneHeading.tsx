export default function PaneHeading({
  eyebrow,
  title,
  note
}: {
  eyebrow: string
  title: string
  note: string
}) {
  return (
    <header className="settings-view__pane-heading">
      <p>{eyebrow}</p>
      <h1>{title}</h1>
      <span>{note}</span>
    </header>
  )
}
