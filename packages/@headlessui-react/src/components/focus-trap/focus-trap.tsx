import * as React from 'react'
import {
  useEffect,
  useRef,

  // Types
  ElementType,
  MutableRefObject,
  Ref,
  FocusEvent as ReactFocusEvent,
} from 'react'

import { Props } from '../../types'
import { forwardRefWithAs, render } from '../../utils/render'
import { useServerHandoffComplete } from '../../hooks/use-server-handoff-complete'
import { useSyncRefs } from '../../hooks/use-sync-refs'
import { Features as HiddenFeatures, Hidden } from '../../internal/hidden'
import { focusElement, focusIn, Focus, FocusResult } from '../../utils/focus-management'
import { match } from '../../utils/match'
import { useEvent } from '../../hooks/use-event'
import { useTabDirection, Direction as TabDirection } from '../../hooks/use-tab-direction'
import { useIsMounted } from '../../hooks/use-is-mounted'
import { useOwnerDocument } from '../../hooks/use-owner'
import { useEventListener } from '../../hooks/use-event-listener'
import { microTask } from '../../utils/micro-task'
import { useWatch } from '../../hooks/use-watch'
import { useDisposables } from '../../hooks/use-disposables'

let DEFAULT_FOCUS_TRAP_TAG = 'div' as const

enum Features {
  /** No features enabled for the focus trap. */
  None = 1 << 0,

  /** Ensure that we move focus initially into the container. */
  InitialFocus = 1 << 1,

  /** Ensure that pressing `Tab` and `Shift+Tab` is trapped within the container. */
  TabLock = 1 << 2,

  /** Ensure that programmatically moving focus outside of the container is disallowed. */
  FocusLock = 1 << 3,

  /** Ensure that we restore the focus when unmounting the focus trap. */
  RestoreFocus = 1 << 4,

  /** Enable all features. */
  All = InitialFocus | TabLock | FocusLock | RestoreFocus,
}

export let FocusTrap = Object.assign(
  forwardRefWithAs(function FocusTrap<TTag extends ElementType = typeof DEFAULT_FOCUS_TRAP_TAG>(
    props: Props<TTag> & {
      initialFocus?: MutableRefObject<HTMLElement | null>
      features?: Features
      containers?: MutableRefObject<Set<MutableRefObject<HTMLElement | null>>>
    },
    ref: Ref<HTMLDivElement>
  ) {
    let container = useRef<HTMLDivElement | null>(null)
    let focusTrapRef = useSyncRefs(container, ref)
    let { initialFocus, containers, features = Features.All, ...theirProps } = props

    if (!useServerHandoffComplete()) {
      features = Features.None
    }

    let ownerDocument = useOwnerDocument(container)

    useRestoreFocus({ ownerDocument }, Boolean(features & Features.RestoreFocus))
    let previousActiveElement = useInitialFocus(
      { ownerDocument, container, initialFocus },
      Boolean(features & Features.InitialFocus)
    )
    useFocusLock(
      { ownerDocument, container, containers, previousActiveElement },
      Boolean(features & Features.FocusLock)
    )

    let direction = useTabDirection()
    let handleFocus = useEvent((e: ReactFocusEvent) => {
      let el = container.current as HTMLElement
      if (!el) return

      // TODO: Cleanup once we are using real browser tests
      let wrapper = process.env.NODE_ENV === 'test' ? microTask : (cb: Function) => cb()
      wrapper(() => {
        match(direction.current, {
          [TabDirection.Forwards]: () => {
            focusIn(el, Focus.First, { skipElements: [e.relatedTarget as HTMLElement] })
          },
          [TabDirection.Backwards]: () => {
            focusIn(el, Focus.Last, { skipElements: [e.relatedTarget as HTMLElement] })
          },
        })
      })
    })

    let d = useDisposables()
    let recentlyUsedTabKey = useRef(false)
    let ourProps = {
      ref: focusTrapRef,
      onKeyDown(e: KeyboardEvent) {
        if (e.key == 'Tab') {
          recentlyUsedTabKey.current = true
          d.requestAnimationFrame(() => {
            recentlyUsedTabKey.current = false
          })
        }
      },
      onBlur(e: ReactFocusEvent) {
        let allContainers = new Set(containers?.current)
        allContainers.add(container)

        let relatedTarget = e.relatedTarget
        if (!(relatedTarget instanceof HTMLElement)) return

        // Known guards, leave them alone!
        if (relatedTarget.dataset.headlessuiFocusGuard === 'true') {
          return
        }

        // Blur is triggered due to focus on relatedTarget, and the relatedTarget is not inside any
        // of the dialog containers. In other words, let's move focus back in!
        if (!contains(allContainers, relatedTarget)) {
          // Was the blur invoke via the keyboard? Redirect to the next in line.
          if (recentlyUsedTabKey.current) {
            focusIn(
              container.current as HTMLElement,
              match(direction.current, {
                [TabDirection.Forwards]: () => Focus.Next,
                [TabDirection.Backwards]: () => Focus.Previous,
              }) | Focus.WrapAround,
              { relativeTo: e.target as HTMLElement }
            )
          }

          // It was invoke via something else (e.g.: click, programmatically, ...). Redirect to the
          // previous active item in the FocusTrap
          else if (e.target instanceof HTMLElement) {
            focusElement(e.target)
          }
        }
      },
    }

    return (
      <>
        {Boolean(features & Features.TabLock) && (
          <Hidden
            as="button"
            type="button"
            data-headlessui-focus-guard
            onFocus={handleFocus}
            features={HiddenFeatures.Focusable}
          />
        )}
        {render({
          ourProps,
          theirProps,
          defaultTag: DEFAULT_FOCUS_TRAP_TAG,
          name: 'FocusTrap',
        })}
        {Boolean(features & Features.TabLock) && (
          <Hidden
            as="button"
            type="button"
            data-headlessui-focus-guard
            onFocus={handleFocus}
            features={HiddenFeatures.Focusable}
          />
        )}
      </>
    )
  }),
  { features: Features }
)

function useRestoreFocus({ ownerDocument }: { ownerDocument: Document | null }, enabled: boolean) {
  let restoreElement = useRef<HTMLElement | null>(null)

  // Capture the currently focused element, before we try to move the focus inside the FocusTrap.
  useEventListener(
    ownerDocument?.defaultView,
    'focusout',
    (event) => {
      if (!enabled) return
      if (restoreElement.current) return

      restoreElement.current = event.target as HTMLElement
    },
    true
  )

  // Restore the focus to the previous element when `enabled` becomes false again
  useWatch(() => {
    if (enabled) return

    if (ownerDocument?.activeElement === ownerDocument?.body) {
      focusElement(restoreElement.current)
    }

    restoreElement.current = null
  }, [enabled])

  // Restore the focus to the previous element when the component is unmounted
  let trulyUnmounted = useRef(false)
  useEffect(() => {
    trulyUnmounted.current = false

    return () => {
      trulyUnmounted.current = true
      microTask(() => {
        if (!trulyUnmounted.current) return

        focusElement(restoreElement.current)
        restoreElement.current = null
      })
    }
  }, [])
}

function useInitialFocus(
  {
    ownerDocument,
    container,
    initialFocus,
  }: {
    ownerDocument: Document | null
    container: MutableRefObject<HTMLElement | null>
    initialFocus?: MutableRefObject<HTMLElement | null>
  },
  enabled: boolean
) {
  let previousActiveElement = useRef<HTMLElement | null>(null)

  let mounted = useIsMounted()

  // Handle initial focus
  useWatch(() => {
    if (!enabled) return
    let containerElement = container.current
    if (!containerElement) return

    // Delaying the focus to the next microtask ensures that a few conditions are true:
    // - The container is rendered
    // - Transitions could be started
    // If we don't do this, then focusing an element will immediately cancel any transitions. This
    // is not ideal because transitions will look broken.
    // There is an additional issue with doing this immediately. The FocusTrap is used inside a
    // Dialog, the Dialog is rendered inside of a Portal and the Portal is rendered at the end of
    // the `document.body`. This means that the moment we call focus, the browser immediately
    // tries to focus the element, which will still be at the bodem resulting in the page to
    // scroll down. Delaying this will prevent the page to scroll down entirely.
    microTask(() => {
      if (!mounted.current) {
        return
      }

      let activeElement = ownerDocument?.activeElement as HTMLElement

      if (initialFocus?.current) {
        if (initialFocus?.current === activeElement) {
          previousActiveElement.current = activeElement
          return // Initial focus ref is already the active element
        }
      } else if (containerElement!.contains(activeElement)) {
        previousActiveElement.current = activeElement
        return // Already focused within Dialog
      }

      // Try to focus the initialFocus ref
      if (initialFocus?.current) {
        focusElement(initialFocus.current)
      } else {
        if (focusIn(containerElement!, Focus.First) === FocusResult.Error) {
          console.warn('There are no focusable elements inside the <FocusTrap />')
        }
      }

      previousActiveElement.current = ownerDocument?.activeElement as HTMLElement
    })
  }, [enabled])

  return previousActiveElement
}

function useFocusLock(
  {
    ownerDocument,
    container,
    containers,
    previousActiveElement,
  }: {
    ownerDocument: Document | null
    container: MutableRefObject<HTMLElement | null>
    containers?: MutableRefObject<Set<MutableRefObject<HTMLElement | null>>>
    previousActiveElement: MutableRefObject<HTMLElement | null>
  },
  enabled: boolean
) {
  let mounted = useIsMounted()

  // Prevent programmatically escaping the container
  useEventListener(
    ownerDocument?.defaultView,
    'focus',
    (event) => {
      if (!enabled) return
      if (!mounted.current) return

      let allContainers = new Set(containers?.current)
      allContainers.add(container)

      let previous = previousActiveElement.current
      if (!previous) return

      let toElement = event.target as HTMLElement | null

      if (toElement && toElement instanceof HTMLElement) {
        if (!contains(allContainers, toElement)) {
          event.preventDefault()
          event.stopPropagation()
          focusElement(previous)
        } else {
          previousActiveElement.current = toElement
          focusElement(toElement)
        }
      } else {
        focusElement(previousActiveElement.current)
      }
    },
    true
  )
}

function contains(containers: Set<MutableRefObject<HTMLElement | null>>, element: HTMLElement) {
  for (let container of containers) {
    if (container.current?.contains(element)) return true
  }

  return false
}
