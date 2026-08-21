import { describe, expect, it } from 'vitest';
import { autoChosenInstall } from './installChoice';
import type { SavedVariablesCandidate } from './types';

function candidate(account: string): SavedVariablesCandidate {
  return {
    installPath: 'C:\World of Warcraft',
    flavour: '_classic_era_',
    account,
    path: `C:\World of Warcraft\WTF\Account\${account}\SavedVariables\Raidify.lua`,
    lootPath: null,
    modifiedAt: new Date(0),
    hasBackup: false,
  };
}

describe('autoChosenInstall', () => {
  it('picks the only candidate, so a single install never needs a click', () => {
    const only = candidate('ALICE');
    expect(autoChosenInstall([only], null)).toBe(only);
  });

  it('asks when there is a real choice to make', () => {
    expect(autoChosenInstall([candidate('ALICE'), candidate('BOB')], null)).toBeNull();
  });

  it('picks nothing from an empty scan', () => {
    expect(autoChosenInstall([], null)).toBeNull();
  });

  it('leaves an existing choice alone, so re-scanning cannot move the officer', () => {
    const other = candidate('BOB');
    expect(autoChosenInstall([other], 'C:\...\ALICE\SavedVariables\Raidify.lua')).toBeNull();
  });
});
