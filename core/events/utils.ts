/**
 * @license
 * Copyright 2021 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Former goog.module ID: Blockly.Events.utils

import type {Block} from '../block.js';
import * as common from '../common.js';
import * as registry from '../registry.js';
import * as idGenerator from '../utils/idgenerator.js';
import type {Workspace} from '../workspace.js';
import type {WorkspaceSvg} from '../workspace_svg.js';
import type {Abstract} from './events_abstract.js';
import type {BlockCreate} from './events_block_create.js';
import type {BlockMove} from './events_block_move.js';
import type {CommentCreate} from './events_comment_create.js';
import type {CommentMove} from './events_comment_move.js';
import type {CommentResize} from './events_comment_resize.js';
import {
  isBlockChange,
  isBlockCreate,
  isBlockMove,
  isBubbleOpen,
  isClick,
  isViewportChange,
} from './predicates.js';
import {EventType} from './type.js';

/** Group ID for new events.  Grouped events are indivisible. */
let group = '';

/** Sets whether the next event should be added to the undo stack. */
let recordUndo = true;

/**
 * Sets whether events should be added to the undo stack.
 *
 * @param newValue True if events should be added to the undo stack.
 */
export function setRecordUndo(newValue: boolean) {
  recordUndo = newValue;
}

/**
 * Returns whether or not events will be added to the undo stack.
 *
 * @returns True if events will be added to the undo stack.
 */
export function getRecordUndo(): boolean {
  return recordUndo;
}

/** Allow change events to be created and fired. */
let disabled = 0;

/**
 * The language-neutral ID for when the reason why a block is disabled is
 * because the block is not descended from a root block.
 */
const ORPHANED_BLOCK_DISABLED_REASON = 'ORPHANED_BLOCK';

/**
 * Type of events that cause objects to be bumped back into the visible
 * portion of the workspace.
 *
 * Not to be confused with bumping so that disconnected connections do not
 * appear connected.
 */
export type BumpEvent =
  | BlockCreate
  | BlockMove
  | CommentCreate
  | CommentMove
  | CommentResize;

/** List of events queued for firing. */
const FIRE_QUEUE: Abstract[] = [];

/**
 * Create a custom event and fire it.
 *
 * @param event Custom data for event.
 */
export function fire(event: Abstract) {
  TEST_ONLY.fireInternal(event);
}

/**
 * Private version of fireInternal for stubbing in tests.
 */
function fireInternal(event: Abstract) {
  if (!isEnabled()) {
    return;
  }
  if (!FIRE_QUEUE.length) {
    // First event added; schedule a firing of the event queue.
    try {
      // If we are in a browser context, we want to make sure that the event
      // fires after blocks have been rerendered this frame.
      requestAnimationFrame(() => {
        setTimeout(fireNow, 0);
      });
    } catch {
      // Otherwise we just want to delay so events can be coallesced.
      // requestAnimationFrame will error triggering this.
      setTimeout(fireNow, 0);
    }
  }
  FIRE_QUEUE.push(event);
}

/** Dispatch all queued events. */
function fireNow() {
  const queue = filter(FIRE_QUEUE, true);
  FIRE_QUEUE.length = 0;
  for (let i = 0, event; (event = queue[i]); i++) {
    if (!event.workspaceId) {
      continue;
    }
    const eventWorkspace = common.getWorkspaceById(event.workspaceId);
    if (eventWorkspace) {
      eventWorkspace.fireChangeListener(event);
    }
  }
}

/**
 * Filter the queued events by merging duplicates, removing null
 * events and reording BlockChange events.
 *
 * History of this function:
 *
 * This function was originally added in commit cf257ea5 with the
 * intention of dramatically reduing the total number of dispatched
 * events.  Initialy it affected only BlockMove events but others were
 * added over time.
 *
 * Code was added to reorder BlockChange events added in commit
 * 5578458, for uncertain reasons but most probably as part of an
 * only-partially-successful attemp to fix problems with event
 * ordering during block mutations.  This code should probably have
 * been added to the top of the function, before merging and
 * null-removal, but was added at the bottom for now-forgotten
 * reasons.  See these bug investigations for a fuller discussion of
 * the underlying issue and some of the failures that arose because of
 * this incomplete/incorrect fix:
 *
 * https://github.com/google/blockly/issues/8225#issuecomment-2195751783
 * https://github.com/google/blockly/issues/2037#issuecomment-2209696351
 *
 * Later, in PR #1205 the original O(n^2) implementation was replaced
 * by a linear-time implementation, though addiitonal fixes were made
 * subsequently.
 *
 * This function was previously called from Workspace.prototype.undo,
 * but this was the cause of issue #7026, the originally-chosen fix
 * for which was the addition (in PR #7069) of code to fireNow to
 * post-filter the .undoStack_ and .redoStack_ of any workspace that
 * had just been involved in dispatching events.  This apparently
 * resolved the issue but added considerable additional complexity and
 * made it difficlut to reason about how events are processed for
 * undo/redo, so both the call from undo and the post-processing code
 * was later removed.
 *
 * @param queueIn Array of events.
 * @param forward True if forward (redo), false if backward (undo).
 * @returns Array of filtered events.
 */
export function filter(queueIn: Abstract[], forward: boolean): Abstract[] {
  let queue = queueIn.slice();
  // Shallow copy of queue.
  if (!forward) {
    // Undo is merged in reverse order.
    queue.reverse();
  }
  const mergedQueue = [];
  const hash = Object.create(null);
  // Merge duplicates.
  for (let i = 0, event; (event = queue[i]); i++) {
    if (!event.isNull()) {
      // Treat all UI events as the same type in hash table.
      const eventType = event.isUiEvent ? EventType.UI : event.type;
      // TODO(#5927): Check whether `blockId` exists before accessing it.
      const blockId = (event as AnyDuringMigration).blockId;
      const key = [eventType, blockId, event.workspaceId].join(' ');

      const lastEntry = hash[key];
      const lastEvent = lastEntry ? lastEntry.event : null;
      if (!lastEntry) {
        // Each item in the hash table has the event and the index of that event
        // in the input array.  This lets us make sure we only merge adjacent
        // move events.
        hash[key] = {event, index: i};
        mergedQueue.push(event);
      } else if (isBlockMove(event) && lastEntry.index === i - 1) {
        // Merge move events.
        lastEvent.newParentId = event.newParentId;
        lastEvent.newInputName = event.newInputName;
        lastEvent.newCoordinate = event.newCoordinate;
        if (event.reason) {
          if (lastEvent.reason) {
            // Concatenate reasons without duplicates.
            const reasonSet = new Set(event.reason.concat(lastEvent.reason));
            lastEvent.reason = Array.from(reasonSet);
          } else {
            lastEvent.reason = event.reason;
          }
        }
        lastEntry.index = i;
      } else if (
        isBlockChange(event) &&
        event.element === lastEvent.element &&
        event.name === lastEvent.name
      ) {
        // Merge change events.
        lastEvent.newValue = event.newValue;
      } else if (isViewportChange(event)) {
        // Merge viewport change events.
        lastEvent.viewTop = event.viewTop;
        lastEvent.viewLeft = event.viewLeft;
        lastEvent.scale = event.scale;
        lastEvent.oldScale = event.oldScale;
      } else if (isClick(event) && isBubbleOpen(lastEvent)) {
        // Drop click events caused by opening/closing bubbles.
      } else {
        // Collision: newer events should merge into this event to maintain
        // order.
        hash[key] = {event, index: i};
        mergedQueue.push(event);
      }
    }
  }
  // Filter out any events that have become null due to merging.
  queue = mergedQueue.filter(function (e) {
    return !e.isNull();
  });
  if (!forward) {
    // Restore undo order.
    queue.reverse();
  }
  // Move mutation events to the top of the queue.
  // Intentionally skip first event.
  for (let i = 1, event; (event = queue[i]); i++) {
    // AnyDuringMigration because:  Property 'element' does not exist on type
    // 'Abstract'.
    if (
      event.type === EventType.BLOCK_CHANGE &&
      (event as AnyDuringMigration).element === 'mutation'
    ) {
      queue.unshift(queue.splice(i, 1)[0]);
    }
  }
  return queue;
}

/**
 * Modify pending undo events so that when they are fired they don't land
 * in the undo stack.  Called by Workspace.clearUndo.
 */
export function clearPendingUndo() {
  for (let i = 0, event; (event = FIRE_QUEUE[i]); i++) {
    event.recordUndo = false;
  }
}

/**
 * Stop sending events.  Every call to this function MUST also call enable.
 */
export function disable() {
  disabled++;
}

/**
 * Start sending events.  Unless events were already disabled when the
 * corresponding call to disable was made.
 */
export function enable() {
  disabled--;
}

/**
 * Returns whether events may be fired or not.
 *
 * @returns True if enabled.
 */
export function isEnabled(): boolean {
  return disabled === 0;
}

/**
 * Current group.
 *
 * @returns ID string.
 */
export function getGroup(): string {
  return group;
}

/**
 * Start or stop a group.
 *
 * @param state True to start new group, false to end group.
 *   String to set group explicitly.
 */
export function setGroup(state: boolean | string) {
  TEST_ONLY.setGroupInternal(state);
}

/**
 * Private version of setGroup for stubbing in tests.
 */
function setGroupInternal(state: boolean | string) {
  if (typeof state === 'boolean') {
    group = state ? idGenerator.genUid() : '';
  } else {
    group = state;
  }
}

/**
 * Compute a list of the IDs of the specified block and all its descendants.
 *
 * @param block The root block.
 * @returns List of block IDs.
 * @internal
 */
export function getDescendantIds(block: Block): string[] {
  const ids = [];
  const descendants = block.getDescendants(false);
  for (let i = 0, descendant; (descendant = descendants[i]); i++) {
    ids[i] = descendant.id;
  }
  return ids;
}

/**
 * Decode the JSON into an event.
 *
 * @param json JSON representation.
 * @param workspace Target workspace for event.
 * @returns The event represented by the JSON.
 * @throws {Error} if an event type is not found in the registry.
 */
export function fromJson(
  json: AnyDuringMigration,
  workspace: Workspace,
): Abstract {
  const eventClass = get(json['type']);
  if (!eventClass) throw Error('Unknown event type.');

  return (eventClass as any).fromJson(json, workspace);
}

/**
 * Gets the class for a specific event type from the registry.
 *
 * @param eventType The type of the event to get.
 * @returns The event class with the given type.
 */
export function get(
  eventType: string,
): new (...p1: AnyDuringMigration[]) => Abstract {
  const event = registry.getClass(registry.Type.EVENT, eventType);
  if (!event) {
    throw new Error(`Event type ${eventType} not found in registry.`);
  }
  return event;
}

/**
 * Set if a block is disabled depending on whether it is properly connected.
 * Use this on applications where all blocks should be connected to a top block.
 *
 * @param event Custom data for event.
 */
export function disableOrphans(event: Abstract) {
  if (isBlockMove(event) || isBlockCreate(event)) {
    const blockEvent = event as BlockMove | BlockCreate;
    if (!blockEvent.workspaceId) {
      return;
    }
    const eventWorkspace = common.getWorkspaceById(
      blockEvent.workspaceId,
    ) as WorkspaceSvg;
    if (!blockEvent.blockId) {
      throw new Error('Encountered a blockEvent without a proper blockId');
    }
    let block = eventWorkspace.getBlockById(blockEvent.blockId);
    if (block) {
      // Changing blocks as part of this event shouldn't be undoable.
      const initialUndoFlag = recordUndo;
      try {
        recordUndo = false;
        const parent = block.getParent();
        if (
          parent &&
          !parent.hasDisabledReason(ORPHANED_BLOCK_DISABLED_REASON)
        ) {
          const children = block.getDescendants(false);
          for (let i = 0, child; (child = children[i]); i++) {
            child.setDisabledReason(false, ORPHANED_BLOCK_DISABLED_REASON);
          }
        } else if (
          (block.outputConnection || block.previousConnection) &&
          !eventWorkspace.isDragging()
        ) {
          do {
            block.setDisabledReason(true, ORPHANED_BLOCK_DISABLED_REASON);
            block = block.getNextBlock();
          } while (block);
        }
      } finally {
        recordUndo = initialUndoFlag;
      }
    }
  }
}

export const TEST_ONLY = {
  FIRE_QUEUE,
  fireNow,
  fireInternal,
  setGroupInternal,
};
