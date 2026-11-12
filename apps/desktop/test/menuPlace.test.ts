import { describe, expect, it } from 'vitest';
import { placeMenu } from '../src/renderer/menuPlace';

describe('placeMenu (item 174)', () => {
  it('hangs from the left edge when the pane has room to the right', () => {
    expect(placeMenu(100, 300, 0, 1400)).toEqual({ alignRight: false });
  });

  it('flips to the right edge when the pane ends before the menu would', () => {
    // Review button at 480–615 in a pane that ends at 675 (terminal docked right).
    expect(placeMenu(480, 615, 0, 675)).toEqual({ alignRight: true });
  });

  it('narrows to the wider side when neither side has room', () => {
    expect(placeMenu(150, 250, 0, 400)).toEqual({ alignRight: false, maxWidth: 242 });
    expect(placeMenu(200, 330, 0, 360)).toEqual({ alignRight: true, maxWidth: 322 });
  });
});
