// src/components/ScopeNote.jsx
//
// Small "this data/answer is scoped to the season selected in the header" reminder,
// reused across Standings/GWWinners/Stats -- Help is the one tab that isn't
// season-scoped, so it doesn't render this. One shared component so the wording and
// styling stay consistent and there's a single place to change either later.
//
// `season` is the resolved display label (e.g. "2026/27"), passed down from App.jsx --
// null while the seasons list is still loading, in which case nothing renders rather
// than a flash of "undefined".
export default function ScopeNote({ season, children }) {
  if (!season) return null;

  return (
    <p className="scope-note">
      {children || `Showing ${season} season data — change season in the picker above`}
    </p>
  );
}
