#!/usr/bin/env python3
"""
Identifies exactly which manager/gameweek combinations are missing from
fpl_entry_gameweek and fpl_league_standings, given a season should have
one record per manager per gameweek (1-38).

Usage:
    aws dynamodb scan --table-name fpl_entry_gameweek --region us-west-2 > /tmp/fpl_entry_gameweek.json
    aws dynamodb scan --table-name fpl_league_standings --region us-west-2 > /tmp/fpl_league_standings.json
    python3 scripts/find_gaps.py /tmp/fpl_entry_gameweek.json /tmp/fpl_league_standings.json
"""
import json
import sys
from collections import defaultdict

TOTAL_GAMEWEEKS = 38


def unwrap(av):
    """Unwrap a DynamoDB low-level AttributeValue, e.g. {'N': '25'} -> 25, {'S': 'x'} -> 'x'."""
    if av is None:
        return None
    if 'N' in av:
        return int(av['N']) if '.' not in av['N'] else float(av['N'])
    if 'S' in av:
        return av['S']
    if 'BOOL' in av:
        return av['BOOL']
    if 'NULL' in av:
        return None
    return av


def unwrap_item(item):
    return {k: unwrap(v) for k, v in item.items()}


def load_items(path):
    with open(path) as f:
        data = json.load(f)
    return [unwrap_item(item) for item in data.get('Items', [])]


def report_gaps(table_name, items, manager_key, gameweek_key, manager_label_key=None):
    by_manager = defaultdict(set)
    label_by_manager = {}

    for item in items:
        manager = item.get(manager_key)
        gw = item.get(gameweek_key)
        if manager is None or gw is None:
            continue
        by_manager[manager].add(gw)
        if manager_label_key and manager not in label_by_manager:
            label_by_manager[manager] = item.get(manager_label_key, manager)

    print(f"\n=== {table_name} ===")
    print(f"Total items: {len(items)}")
    print(f"Distinct managers present: {len(by_manager)}")

    all_expected = set(range(1, TOTAL_GAMEWEEKS + 1))
    total_missing = 0

    for manager in sorted(by_manager.keys(), key=lambda m: str(m)):
        present = by_manager[manager]
        missing = sorted(all_expected - present)
        label = label_by_manager.get(manager, manager)
        if missing:
            total_missing += len(missing)
            print(f"  {label} ({manager}): missing GW {missing}  ({len(present)}/{TOTAL_GAMEWEEKS} present)")

    print(f"Total manager-gameweek gaps: {total_missing}")

    # Also flag gameweeks missing across ALL managers (a full-week outage)
    gw_coverage = defaultdict(int)
    for present in by_manager.values():
        for gw in present:
            gw_coverage[gw] += 1
    fully_missing_weeks = [gw for gw in range(1, TOTAL_GAMEWEEKS + 1) if gw_coverage.get(gw, 0) == 0]
    if fully_missing_weeks:
        print(f"Gameweeks with ZERO managers present (full outage): {fully_missing_weeks}")
    partial_weeks = [gw for gw in range(1, TOTAL_GAMEWEEKS + 1)
                     if 0 < gw_coverage.get(gw, 0) < len(by_manager)]
    if partial_weeks:
        print(f"Gameweeks with partial coverage (some but not all managers): {partial_weeks}")


def main():
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(1)

    entry_gw_path, standings_path = sys.argv[1], sys.argv[2]

    entry_gw_items = load_items(entry_gw_path)
    # season_entry looks like "2025/26#162357" -- the manager identifier is entry_id,
    # but season_entry itself is unique per manager so it works fine as the grouping key.
    report_gaps(
        "fpl_entry_gameweek",
        entry_gw_items,
        manager_key='season_entry',
        gameweek_key='gameweek',
        manager_label_key='team_nickname'  # renamed 2026-08-14 from manager_name -- see DATA_MODEL.md
    )

    standings_items = load_items(standings_path)
    # season_event looks like "2025/26#25" -- that's the GAMEWEEK key here, not the manager.
    # The manager here is manager_id (with team_nickname as a friendly label), and gameweek
    # has to be parsed out of season_event's suffix.
    for item in standings_items:
        se = item.get('season_event', '')
        if '#' in se:
            item['_gw_from_season_event'] = int(se.rsplit('#', 1)[1])
    report_gaps(
        "fpl_league_standings",
        standings_items,
        manager_key='manager_id',
        gameweek_key='_gw_from_season_event',
        manager_label_key='team_nickname'  # renamed 2026-08-14 from manager_name -- see DATA_MODEL.md
    )


if __name__ == '__main__':
    main()
