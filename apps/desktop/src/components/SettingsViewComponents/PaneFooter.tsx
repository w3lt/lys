import { Button } from "@/components/ui/button";

export default function PaneFooter({ onDone }: { onDone: () => void }) {
  return (
    <footer className="settings-view__footer">
      <p>Changes live in this session only. Nothing is written to disk.</p>
      <Button onClick={onDone} type="button">
        Done
      </Button>
    </footer>
  )
}