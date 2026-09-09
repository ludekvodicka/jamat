import { app } from 'electron'

import { AppClientUiReport } from './shared/appClientUiReport'
import { ErrorText } from './shared/errorText'
import { AppClientUi } from './app/app'

void AppClientUi.run(import.meta.url).catch((error: unknown) => {
  AppClientUiReport.error(`${ErrorText.detailOf(error)}`)
  app.exit(1)
})
