---
title: Obyčejný markdown
flavor: markdown
purpose: stejný renderer, jiná přípona
---

# Obyčejný markdown

Tenhle soubor má příponu `.md`, ne `.mdext`. Renderer je stejný, v deskriptoru dokumentu
se ale liší `flavor`. Vedle toho slouží jako soubor, který se mění v pracovní kopii,
takže na něm jde vyzkoušet Rendered, Raw i Diff na jednom dokumentu.

## Co v něm je

- tabulka
- task list
- fence s jazykem
- jeden callout, který v čistém markdownu degraduje na text

| Vrstva | Balíček | Co vlastní |
|---|---|---|
| knihovna | lib-orchestrator | subsystémy bez procesu |
| host | app-host | PTY, které přežijí klienta |
| klient | app-client-ui | okna, taby, plochy |

- [x] projekt se otevře
- [ ] session naběhne
- [ ] soubor se vykreslí

```ts
const modes = ['rendered', 'raw', 'diff'] as const
export type Mode = (typeof modes)[number]
```

:::note
Callout uvnitř `.md` funguje stejně jako v `.mdext`. Přípona nerozhoduje o pipeline.
:::

## Řádky pro diff

Následující blok je tu proto, aby měl diff co ukázat. Generátor jeden z těchto řádků
změní, takže se v Diff režimu objeví jeden hunk s kontextem kolem.

1. řádek jedna, beze změny
2. řádek dva, beze změny
3. řádek tři, tenhle se mění
4. řádek čtyři, beze změny
5. řádek pět, beze změny
