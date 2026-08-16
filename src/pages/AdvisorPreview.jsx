// src/pages/AdvisorPreview.jsx
//
// DEV-ONLY preview route -- not linked from any nav, only reachable by typing
// /__advisor-preview directly into the address bar. Renders ManagerSquad with a
// hardcoded mock squad (same shape the real /manager-squad endpoint returns) instead of
// fetching one, so the GH #44 Advisor sparkle button + mock suggestions panel (see
// MOCK_ADVISOR in components/ManagerSquad.jsx) can be reviewed without depending on
// live picks data. Useful right now specifically because the 2026/27 season hasn't
// reached its GW1 deadline yet -- Standings has no real squad to click into at all, so
// this is the only way to see the Advisor mock today. Safe to delete (along with its
// route in main.jsx) once the season has live picks, or keep it as a permanent
// design-review harness -- either is fine, it never ships user-facing content.
import { useEffect, useState } from 'react';
import ManagerSquad from '../components/ManagerSquad';
import '../styles/App.css';

const MOCK_SQUAD = {
  gameweek: 4,
  team_gw_points_net: 68,
  transfer_cost: 4,
  players: [
    { player_id: 1, name: 'Alisson', position: 'GKP', team_code: 'LIV', team_crest: '/badges/t14.png', is_bench: false, form_tag: 'neutral', gw_points: 6,
      fixtures: [{ opponent_code: 'ARS', is_home: true, difficulty: 3 }, { opponent_code: 'MCI', is_home: false, difficulty: 4 }] },
    { player_id: 2, name: 'Trent Alexander-Arnold', position: 'DEF', team_code: 'LIV', team_crest: '/badges/t14.png', is_bench: false, form_tag: 'hot', gw_points: 8,
      fixtures: [{ opponent_code: 'ARS', is_home: true, difficulty: 3 }, { opponent_code: 'MCI', is_home: false, difficulty: 4 }] },
    { player_id: 3, name: 'William Saliba', position: 'DEF', team_code: 'ARS', team_crest: '/badges/t3.png', is_bench: false, form_tag: 'neutral', gw_points: 2,
      fixtures: [{ opponent_code: 'LIV', is_home: false, difficulty: 3 }, { opponent_code: 'BOU', is_home: true, difficulty: 2 }] },
    { player_id: 4, name: 'Struggling Def', position: 'DEF', team_code: 'EVE', team_crest: '/badges/t11.png', is_bench: false, form_tag: 'cold', gw_points: 1,
      fixtures: [{ opponent_code: 'CHE', is_home: false, difficulty: 4 }, { opponent_code: 'WHU', is_home: true, difficulty: 3 }] },
    { player_id: 5, name: 'Bukayo Saka', position: 'MID', team_code: 'ARS', team_crest: '/badges/t3.png', is_captain: true, is_bench: false, form_tag: 'hot', gw_points: 18,
      fixtures: [{ opponent_code: 'LIV', is_home: false, difficulty: 3 }, { opponent_code: 'BOU', is_home: true, difficulty: 2 }] },
    { player_id: 6, name: 'Mohamed Salah', position: 'MID', team_code: 'LIV', team_crest: '/badges/t14.png', is_vice_captain: true, is_bench: false, form_tag: 'neutral', gw_points: 9,
      fixtures: [{ opponent_code: 'ARS', is_home: true, difficulty: 3 }, { opponent_code: 'MCI', is_home: false, difficulty: 4 }] },
    { player_id: 7, name: 'Cole Palmer', position: 'MID', team_code: 'CHE', team_crest: '/badges/t8.png', is_bench: false, form_tag: 'cold', gw_points: 2,
      fixtures: [{ opponent_code: 'EVE', is_home: true, difficulty: 3 }] },
    { player_id: 8, name: 'Bruno Fernandes', position: 'MID', team_code: 'MUN', team_crest: '/badges/t1.png', is_bench: false, form_tag: 'neutral', gw_points: 6,
      fixtures: [{ opponent_code: 'NEW', is_home: false, difficulty: 4 }] },
    { player_id: 9, name: 'Erling Haaland', position: 'FWD', team_code: 'MCI', team_crest: '/badges/t43.png', is_bench: false, form_tag: 'hot', gw_points: 12,
      fixtures: [{ opponent_code: 'LIV', is_home: true, difficulty: 4 }, { opponent_code: 'BHA', is_home: false, difficulty: 2 }] },
    { player_id: 10, name: 'Ollie Watkins', position: 'FWD', team_code: 'AVL', team_crest: '/badges/t7.png', is_bench: false, form_tag: 'neutral', gw_points: 4,
      fixtures: [{ opponent_code: 'TOT', is_home: false, difficulty: 3 }] },
    { player_id: 11, name: 'Alexander Isak', position: 'FWD', team_code: 'NEW', team_crest: '/badges/t4.png', is_bench: false, form_tag: 'cold', gw_points: 0,
      fixtures: [{ opponent_code: 'SUN', is_home: true, difficulty: 2 }, { opponent_code: 'BUR', is_home: false, difficulty: 2 }] },
    { player_id: 12, name: 'Jordan Pickford', position: 'GKP', team_code: 'EVE', team_crest: '/badges/t11.png', is_bench: true, form_tag: 'neutral', gw_points: 3,
      fixtures: [{ opponent_code: 'CHE', is_home: false, difficulty: 4 }] },
    { player_id: 13, name: 'Backup Defender', position: 'DEF', team_code: 'CRY', team_crest: '/badges/t31.png', is_bench: true, form_tag: 'neutral', gw_points: 0,
      fixtures: [{ opponent_code: 'LEE', is_home: true, difficulty: 2 }] },
    { player_id: 14, name: 'Backup Midfielder', position: 'MID', team_code: 'FUL', team_crest: '/badges/t54.png', is_bench: true, form_tag: 'neutral', gw_points: 1,
      fixtures: [{ opponent_code: 'AVL', is_home: false, difficulty: 3 }] },
    { player_id: 15, name: 'Backup Forward', position: 'FWD', team_code: 'WHU', team_crest: '/badges/t21.png', is_bench: true, form_tag: 'neutral', gw_points: 0,
      fixtures: [{ opponent_code: 'EVE', is_home: false, difficulty: 3 }] }
  ]
};

export default function AdvisorPreview() {
  // Reads whatever theme was last saved by the real App (same localStorage key), with a
  // manual toggle here too -- worth checking the sparkle/hover treatment in both modes
  // without needing to open the real app in another tab just to flip the switch.
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || 'dark');

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-page)', padding: '2rem 1rem' }}>
      <div style={{ maxWidth: 480, margin: '0 auto' }}>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginBottom: '0.75rem' }}>
          /__advisor-preview -- dev-only, mock squad data, not linked from the app anywhere.
        </p>
        <button
          type="button"
          onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
          style={{
            marginBottom: '1rem', padding: '0.4rem 0.9rem', borderRadius: 8,
            border: '1px solid var(--border)', background: 'var(--bg-surface)',
            color: 'var(--text-primary)', cursor: 'pointer', fontSize: '0.85rem'
          }}
        >
          Switch to {theme === 'dark' ? 'light' : 'dark'} mode
        </button>
        <ManagerSquad
          entryId={0}
          teamName="Preview FC"
          managerName="Preview Manager"
          mockSquad={MOCK_SQUAD}
          onClose={() => {}}
        />
      </div>
    </div>
  );
}
