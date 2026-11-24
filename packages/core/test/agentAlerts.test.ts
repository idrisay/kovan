import { describe, expect, it } from 'vitest';
import { agentAlertKind, agentAlertNotices, type AgentAlert } from '../src/agentAlerts';

describe('agentAlertKind', () => {
  it('alerts when an agent stops to ask, from any other state', () => {
    expect(agentAlertKind('working', 'input')).toBe('input');
    expect(agentAlertKind('done', 'input')).toBe('input');
  });

  it('alerts when a turn of work ends', () => {
    expect(agentAlertKind('working', 'done')).toBe('done');
  });

  it('stays quiet on the first word heard, which may be from before launch', () => {
    expect(agentAlertKind(undefined, 'input')).toBeUndefined();
    expect(agentAlertKind(undefined, 'done')).toBeUndefined();
  });

  it('stays quiet when you answer, and when nothing changed', () => {
    expect(agentAlertKind('input', 'working')).toBeUndefined();
    expect(agentAlertKind('input', 'done')).toBeUndefined();
    expect(agentAlertKind('done', 'working')).toBeUndefined();
    expect(agentAlertKind('input', 'input')).toBeUndefined();
  });
});

const alert = (kind: AgentAlert['kind'], n: number): AgentAlert =>
  ({ kind, sessionId: `s${n}`, title: `Fix ACME-${n}`, runnerName: 'Claude' });

describe('agentAlertNotices', () => {
  it('gives one or two alerts a notification each, input first, each opening its session', () => {
    expect(agentAlertNotices([alert('done', 1), alert('input', 2)])).toEqual([
      { title: 'Waiting for you', subtitle: 'Claude', body: 'Fix ACME-2', sessionId: 's2' },
      { title: 'Agent finished', subtitle: 'Claude', body: 'Fix ACME-1', sessionId: 's1' }
    ]);
  });

  it('sums up three or more in one', () => {
    expect(agentAlertNotices([alert('done', 1), alert('input', 2), alert('done', 3)])).toEqual([
      { title: 'Kovan', body: '3 agents: 1 waiting for you, 2 finished' }
    ]);
    expect(agentAlertNotices([alert('done', 1), alert('done', 2), alert('done', 3)])[0]!.body)
      .toBe('3 agents: 3 finished');
  });

  it('says nothing for nothing', () => {
    expect(agentAlertNotices([])).toEqual([]);
  });
});
