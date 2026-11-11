import { readFileSync } from 'node:fs';

export function readReleaseInfo(file = new URL('../version.json', import.meta.url)) {
  try {
    const info = JSON.parse(readFileSync(file, 'utf8'));
    if (info.app !== 'svoi-telegram' || !/^[0-9a-f]{40}$/.test(info.commit) || !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(info.repository) || info.databaseSchema !== 2 || !Number.isFinite(Date.parse(info.builtAt))) throw new Error('Invalid release metadata');
    return Object.freeze({ commit: info.commit, repository: info.repository, builtAt: info.builtAt });
  } catch (error) {
    // A checkout is allowed to run locally. A present but invalid release file fails closed.
    if (error.code === 'ENOENT') return Object.freeze({ commit: null, repository: null, builtAt: null });
    throw error;
  }
}
