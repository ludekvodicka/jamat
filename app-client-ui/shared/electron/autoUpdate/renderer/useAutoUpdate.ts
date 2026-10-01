import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { DtoAutoUpdateStatus } from "../common/autoUpdate.dto";
import type { AutoUpdateApi } from "../common/autoUpdateApi";
import { AutoUpdateView, type AutoUpdateViewModel } from "../common/autoUpdateView";
import { AutoUpdateStore } from "./autoUpdateStore";

export interface AutoUpdateController
{
  status: DtoAutoUpdateStatus | null;
  view: AutoUpdateViewModel | null;
  check(): void;
  install(): void;
  openReleasePage(): void;
}

export function useAutoUpdate(api: AutoUpdateApi): AutoUpdateController
{
  const [store] = useState(() => new AutoUpdateStore(api));
  useEffect(() =>
  {
    store.start();
    return () => store.stop();
  }, [store]);
  const status = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return useMemo(() => ({
    status,
    view: status && AutoUpdateView.describe(status),
    check: () => void api.check().catch(warn),
    install: () => void api.install().catch(warn),
    openReleasePage: () => void api.openReleasePage().catch(warn),
  }), [api, status]);
}

function warn(error: unknown): void
{
  console.warn("Update action failed", error);
}
