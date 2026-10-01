import type { IpcRenderer, IpcRendererEvent } from "electron";
import type { DtoAutoUpdateStatus } from "../common/autoUpdate.dto";
import { type AutoUpdateApi, AutoUpdateConst } from "../common/autoUpdateApi";

// Type-only electron import: the preload runs sandboxed as a CommonJS bundle and receives ipcRenderer from its caller.
export class AutoUpdateBridge
{
  static create(ipcRenderer: Pick<IpcRenderer, "invoke" | "on" | "removeListener">): AutoUpdateApi
  {
    return {
      status: () => ipcRenderer.invoke(AutoUpdateConst.channelStatus),
      check: () => ipcRenderer.invoke(AutoUpdateConst.channelCheck),
      install: () => ipcRenderer.invoke(AutoUpdateConst.channelInstall),
      openReleasePage: () => ipcRenderer.invoke(AutoUpdateConst.channelOpenReleasePage),
      onChanged: listener =>
      {
        const handler = (_event: IpcRendererEvent, status: DtoAutoUpdateStatus) => listener(status);
        ipcRenderer.on(AutoUpdateConst.channelChanged, handler);
        return () => ipcRenderer.removeListener(AutoUpdateConst.channelChanged, handler);
      },
    };
  }
}
