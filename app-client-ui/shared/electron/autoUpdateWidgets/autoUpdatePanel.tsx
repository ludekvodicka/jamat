import type { AutoUpdateController } from "../autoUpdate/renderer/useAutoUpdate";
import "./autoUpdateWidgets.css";

export function AutoUpdatePanel(props: { update: AutoUpdateController; open: boolean; onClose(): void })
{
  const view = props.update.view;
  if (!props.open || !view)
    return null;
  const release = view.release;
  return (
    <div className="auto-update-backdrop" onClick={props.onClose}>
      <section className="auto-update-panel" role="dialog" aria-modal="true" aria-labelledby="auto-update-title"
        onClick={event => event.stopPropagation()}>
        <h2 id="auto-update-title">{view.text}</h2>
        {view.detail && <p className="auto-update-detail">{view.detail}</p>}
        {release &&
          <p className="auto-update-meta">{release.name ?? release.version}{release.date && ` (${release.date.slice(0, 10)})`}</p>}
        {release?.notes && <pre className="auto-update-notes">{release.notes}</pre>}
        <div className="auto-update-actions">
          {view.actions.includes("check") &&
            <button type="button" className="auto-update-button" onClick={props.update.check}>Check now</button>}
          {view.actions.includes("install") &&
            <button type="button" className="auto-update-button auto-update-primary" onClick={props.update.install}>Restart and install</button>}
          {view.actions.includes("openRelease") &&
            <button type="button" className="auto-update-button" onClick={props.update.openReleasePage}>View on GitHub</button>}
          <button type="button" className="auto-update-button" onClick={props.onClose}>Close</button>
        </div>
      </section>
    </div>
  );
}
