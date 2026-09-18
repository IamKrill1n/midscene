import type { TreeOnlyBrowserAdapter } from '@midscene/core/tree-only';
import { TreeOnlyOperationError } from '@midscene/core/tree-only';
import type { WebPage } from './page';
import { captureTreeOnlyBrowserSnapshot } from './snapshot-collector';

/** Keep real DOM identities in a private handle, never in Jev's JSON. */
export function createPlaywrightTreeOnlyAdapter(
  webPage: WebPage,
): TreeOnlyBrowserAdapter {
  return {
    async capture() {
      const page = webPage.underlyingPage;
      if (page.context().browser()?.browserType().name() !== 'chromium') {
        throw new TreeOnlyOperationError(
          'Tree-only Jev currently supports Playwright Chromium only',
          'unsupported-operation',
        );
      }
      await page.evaluate(() => {
        (
          window as unknown as { midsceneNodeHashCache?: Map<string, Node> }
        ).midsceneNodeHashCache = new Map();
      });
      const collected = await captureTreeOnlyBrowserSnapshot(webPage);
      const identities = [...collected.backend].map(([ref, backend]) => [
        ref,
        backend.nodeHashId,
      ]);
      let handles: Awaited<ReturnType<typeof page.evaluateHandle>> | undefined;
      try {
        const acquiredHandles = await page.evaluateHandle((entries) => {
          const cache = (
            window as unknown as { midsceneNodeHashCache?: Map<string, Node> }
          ).midsceneNodeHashCache;
          return new Map(entries.map(([ref, id]) => [ref, cache?.get(id)]));
        }, identities);
        handles = acquiredHandles;
        const url = page.url();
        const title = await page.title();
        let scroll: { y: number; height: number } | undefined;
        try {
          const measured = await page.evaluate(() => ({
            y: window.scrollY,
            height: document.documentElement.scrollHeight,
          }));
          if (
            Number.isFinite(measured?.y) &&
            Number.isFinite(measured?.height)
          ) {
            scroll = { y: measured.y, height: measured.height };
          }
        } catch {
          // Scroll context is advisory; capture stays valid without it.
        }
        let released = false;
        return {
          snapshot: collected.snapshot,
          page: {
            url,
            title,
            text: collected.snapshot.nodes
              .map((node) => node.text ?? node.name ?? '')
              .filter(Boolean)
              .join('\n'),
            ...(scroll ? { scroll } : {}),
          },
          async validate(ref, action) {
            if (
              released ||
              page.url() !== url ||
              !collected.resolver.has(ref)
            ) {
              throw new TreeOnlyOperationError(
                'Tree target is no longer current',
                'stale-target',
              );
            }
            const result = await acquiredHandles.evaluate(
              (mapping, input) => {
                const node = mapping.get(input.ref);
                const element =
                  node instanceof Element ? node : node?.parentElement;
                if (!element?.isConnected || element.ownerDocument !== document)
                  return { error: 'stale' } as const;
                const style = getComputedStyle(element);
                const rect = element.getBoundingClientRect();
                if (
                  style.visibility === 'hidden' ||
                  style.display === 'none' ||
                  Number(style.opacity) === 0 ||
                  rect.width <= 0 ||
                  rect.height <= 0
                )
                  return { error: 'obstructed' } as const;
                if (element.matches(':disabled, [aria-disabled="true"]'))
                  return { error: 'obstructed' } as const;
                if (
                  input.action === 'TYPE_TEXT' &&
                  (!element.matches(
                    'input:not([type=checkbox]):not([type=radio]):not([type=hidden]):not([type=file]), textarea, [contenteditable="true"]',
                  ) ||
                    element.matches('[readonly], [aria-readonly="true"]'))
                )
                  return { error: 'obstructed' } as const;
                const left = Math.max(0, rect.left);
                const top = Math.max(0, rect.top);
                const right = Math.min(innerWidth, rect.right);
                const bottom = Math.min(innerHeight, rect.bottom);
                if (right <= left || bottom <= top)
                  return { error: 'obstructed' } as const;
                const center: [number, number] = [
                  (left + right) / 2,
                  (top + bottom) / 2,
                ];
                let hit = document.elementFromPoint(...center);
                while (hit?.shadowRoot) {
                  const inner = hit.shadowRoot.elementFromPoint(...center);
                  if (!inner || inner === hit) break;
                  hit = inner;
                }
                if (!hit || !(element === hit || element.contains(hit)))
                  return { error: 'obstructed' } as const;
                return {
                  center,
                  rect: {
                    left: rect.left,
                    top: rect.top,
                    width: rect.width,
                    height: rect.height,
                  },
                };
              },
              { ref, action },
            );
            if ('error' in result)
              throw new TreeOnlyOperationError(
                `Tree target ${ref} is ${result.error}`,
                result.error === 'stale' ? 'stale-target' : 'obstruction',
              );
            return {
              ...result,
              description: collected.resolver.resolve(ref)?.name ?? ref,
            };
          },
          async release() {
            if (!released) {
              released = true;
              await acquiredHandles.dispose();
            }
          },
        };
      } catch (error) {
        await handles?.dispose();
        throw error;
      }
    },
  };
}
