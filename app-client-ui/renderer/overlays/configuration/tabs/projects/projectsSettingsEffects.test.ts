import { afterEach, describe, expect, it } from 'vitest'

import type {
  CatalogCategoryDto,
} from '../../../../../../lib-orchestrator/projectManager/projectManagerApi.types'
import type { AppClientUiBridge } from '../../../../../shared/appClientUiIpc'
import { ProjectsSettingsEffects, type ProjectsSettingsPorts } from './projectsSettingsEffects'
import type { ProjectsSettingsEffect, ProjectsSettingsInput } from './projectsSettingsModel'

describe('app-client-ui/renderer/overlays/configuration/tabs/projects/projectsSettingsEffects', () => {
  const categoriesConst: CatalogCategoryDto[] = [{
    id: 'nodejs',
    label: 'NodeJs',
    path: 'C:/Projects/NodeJs',
    futureCategoryKey: 'kept',
  }]

  /** Only the two surfaces this tab reaches, and every answer either of them can give. */
  class BridgeStub {
    readonly saved: CatalogCategoryDto[][] = []
    readonly pickTitles: string[] = []
    private getAnswer: unknown = { ok: true, value: { ok: true, value: categoriesConst } }
    private saveAnswer: unknown = { ok: true, value: { ok: true, value: undefined } }
    private pickAnswer: unknown = { ok: true, value: null }

    install(): void {
      const bridge = {
        projects: {
          getConfig: () => Promise.resolve(this.getAnswer),
          saveConfig: (categories: CatalogCategoryDto[]) => {
            this.saved.push(categories)
            return Promise.resolve(this.saveAnswer)
          },
        },
        dialog: {
          pickDirectory: (title: string) => {
            this.pickTitles.push(title)
            return Promise.resolve(this.pickAnswer)
          },
        },
      }
      ;(window as unknown as { appClient: unknown }).appClient = bridge as unknown as
        Pick<AppClientUiBridge, 'projects' | 'dialog'>
    }

    answersGetWith(answer: unknown): this {
      this.getAnswer = answer
      return this
    }

    answersSaveWith(answer: unknown): this {
      this.saveAnswer = answer
      return this
    }

    answersPickWith(answer: unknown): this {
      this.pickAnswer = answer
      return this
    }
  }

  function recorder(): { ports: ProjectsSettingsPorts; inputs: ProjectsSettingsInput[] } {
    const inputs: ProjectsSettingsInput[] = []
    return { ports: { dispatch: (input) => inputs.push(input) }, inputs }
  }

  async function run(
    effect: ProjectsSettingsEffect,
    stub: BridgeStub,
  ): Promise<ProjectsSettingsInput[]> {
    stub.install()
    const { ports, inputs } = recorder()
    await ProjectsSettingsEffects.run(effect, ports)
    return inputs
  }

  afterEach(() => {
    delete (window as unknown as { appClient?: unknown }).appClient
  })

  it('refuses an effect it does not know', async () => {
    await expect(ProjectsSettingsEffects.run(
      { effect: 'nonsense' } as unknown as ProjectsSettingsEffect,
      recorder().ports,
    )).rejects.toThrow(/Unknown projects settings effect/)
  })

  it('hands the roots the store answered with straight to the model', async () => {
    expect(await run({ effect: 'load' }, new BridgeStub()))
      .toEqual([{ input: 'loaded', categories: categoriesConst }])
  })

  it('sends every root to the store, unknown keys and all', async () => {
    const stub = new BridgeStub()

    const inputs = await run({ effect: 'save', categories: categoriesConst }, stub)

    expect(stub.saved).toEqual([categoriesConst])
    expect(inputs).toEqual([{ input: 'saved', ok: true }])
  })

  /**
   * The point of the two unwraps. A store that refused says which rule it refused under, and those
   * words reach the user; a channel that never answered says so in its own words, so nobody retries
   * an edit over a main process that is gone.
   */
  it('reports a refused save in the words the store used', async () => {
    const stub = new BridgeStub().answersSaveWith({
      ok: true,
      value: {
        ok: false,
        code: 'catalog-latched',
        detail: 'Catalog at Q:/config.json is unreadable; nothing is written until it is repaired',
      },
    })

    expect(await run({ effect: 'save', categories: categoriesConst }, stub)).toEqual([{
      input: 'saved',
      ok: false,
      detail: 'catalog-latched: Catalog at Q:/config.json is unreadable; nothing is written until it is repaired',
    }])
  })

  it('reports an invalid root the store refused rather than swallowing it', async () => {
    const stub = new BridgeStub().answersSaveWith({
      ok: true,
      value: { ok: false, code: 'invalid-config', detail: 'category nodejs: label must be a non-empty string' },
    })

    expect(await run({ effect: 'save', categories: categoriesConst }, stub)).toEqual([{
      input: 'saved',
      ok: false,
      detail: 'invalid-config: category nodejs: label must be a non-empty string',
    }])
  })

  it('tells a broken channel apart from a refusal, on the save and on the load', async () => {
    const brokenSave = new BridgeStub().answersSaveWith({ ok: false, error: 'main process is gone' })
    expect(await run({ effect: 'save', categories: categoriesConst }, brokenSave))
      .toEqual([{ input: 'failed', detail: 'The main process did not answer: main process is gone' }])

    const brokenLoad = new BridgeStub().answersGetWith({ ok: false, error: 'main process is gone' })
    expect(await run({ effect: 'load' }, brokenLoad))
      .toEqual([{ input: 'failed', detail: 'The main process did not answer: main process is gone' }])
  })

  it('reports a catalog that could not be read as the store described it', async () => {
    const stub = new BridgeStub().answersGetWith({
      ok: true,
      value: { ok: false, code: 'catalog-latched', detail: 'unreadable' },
    })

    expect(await run({ effect: 'load' }, stub))
      .toEqual([{ input: 'failed', detail: 'catalog-latched: unreadable' }])
  })

  it('adds the directory the picker returned', async () => {
    const stub = new BridgeStub().answersPickWith({ ok: true, value: { path: 'C:/Projects/Ai' } })

    const inputs = await run({ effect: 'pick-directory' }, stub)

    expect(stub.pickTitles).toEqual(['Choose a projects root'])
    expect(inputs).toEqual([{ input: 'add', path: 'C:/Projects/Ai' }])
  })

  // Cancelling is an answer, not a failure: nothing is added and nothing is said about it.
  it('says nothing at all when the picker was cancelled', async () => {
    expect(await run({ effect: 'pick-directory' }, new BridgeStub().answersPickWith({
      ok: true,
      value: null,
    }))).toEqual([])
  })

  it('reports a picker that could not be opened', async () => {
    const stub = new BridgeStub().answersPickWith({ ok: false, error: 'no window' })

    expect(await run({ effect: 'pick-directory' }, stub))
      .toEqual([{ input: 'failed', detail: 'The main process did not answer: no window' }])
  })
})
