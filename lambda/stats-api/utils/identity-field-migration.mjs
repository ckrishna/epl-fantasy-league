// Pure transforms backing scripts/migrate-identity-field-names.mjs -- renames the
// long-standing team_name/manager_name naming inversion (team_name actually held a
// manager's REAL NAME; manager_name actually held their FPL squad NICKNAME -- see
// DATA_MODEL.md's naming-inversion notes) to explicit, unambiguous field names:
// real_name and team_nickname.
//
// Deliberately new names rather than literally swapping the two existing ones. A swap
// would leave two familiar-looking keys whose meaning silently changed again -- the
// same failure shape as the original bug, just inverted. A missed call site after a
// rename to brand-new names fails loudly (undefined) instead of silently reading the
// wrong value.

// True if `item` still has the OLD field names present as its own properties -- used
// by the migration script to skip already-migrated items, so a partial failure can be
// safely resumed by just re-running the same command.
export function needsFlatRename(item) {
  return Object.prototype.hasOwnProperty.call(item, 'team_name')
    || Object.prototype.hasOwnProperty.call(item, 'manager_name');
}

// For fpl_entry_gameweek / fpl_league_standings rows: the new field values to write,
// given the old item. team_nickname stays nullable -- manager_name is null on every
// historical-import row (no team nickname existed in that source data -- see
// DATA_MODEL.md's historical backfill notes), and that's still a legitimate "unknown"
// after the rename, not a bug to paper over.
export function renameFlatIdentityFields(item) {
  return {
    real_name: item.team_name,
    team_nickname: item.manager_name ?? null
  };
}

// For gw-winners-cache's nested `winners` list: same rename, applied per entry. Every
// other field on each winner entry (entry_id, net_points, gross_points, transfer_cost)
// passes through untouched.
export function renameWinnersList(winners) {
  return (winners || []).map((w) => {
    const { team_name, manager_name, ...rest } = w;
    return { ...rest, real_name: team_name, team_nickname: manager_name ?? null };
  });
}

export function winnersListNeedsRename(winners) {
  return (winners || []).some((w) => needsFlatRename(w));
}
