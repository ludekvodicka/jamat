import type { AutoUpdateController } from "../autoUpdate/renderer/useAutoUpdate";
import "./autoUpdateWidgets.css";

export function AutoUpdateIndicator(props: { update: AutoUpdateController; onOpen(): void; className?: string })
{
  const view = props.update.view;
  if (!view)
    return null;
  const className = ["auto-update-indicator", `auto-update-tone-${view.tone}`, props.className].filter(Boolean).join(" ");
  return (
    <span className={className}>
      <button type="button" className="auto-update-label" title={view.detail ?? undefined} onClick={props.onOpen}>
        <span className="auto-update-dot" aria-hidden="true" />
        {view.text}
      </button>
      {view.actions.includes("install") &&
        <button type="button" className="auto-update-button auto-update-primary" onClick={props.update.install}>Restart and install</button>}
    </span>
  );
}
