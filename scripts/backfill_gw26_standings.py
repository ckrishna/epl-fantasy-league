#!/usr/bin/env python3
"""
Backfills fpl_league_standings for GW26, which is missing for every manager even
though the raw fpl_entry_gameweek data for GW26 exists (confirmed via find_gaps.py).

Recomputes the standings snapshot exactly the way the ingester does it (the
manager's known record as of the target gameweek) and writes it to
fpl_league_standings under the correct season_event key, using only data already
in DynamoDB -- no FPL API calls needed.

Usage:
    # 1. Dry run (default) -- shows exactly what would be written, writes nothing:
    python3 scripts/backfill_gw26_standings.py

    # 2. Apply for real:
    python3 scripts/backfill_gw26_standings.py --apply
"""
import argparse
import json
import subprocess
import sys
from datetime import datetime, timezone

REGION = 'us-west-2'
SEASON = '2025/26'
TARGET_GW = 26


def aws_json(args):
    result = subprocess.run(
        ['aws'] + args + ['--region', REGION, '--output', 'json'],
        capture_output=True, text=True
    )
    if result.returncode != 0:
        print(f"AWS CLI error: {result.stderr}", file=sys.stderr)
        sys.exit(1)
    return json.loads(result.stdout) if result.stdout.strip() else {}


def unwrap(av):
    if 'N' in av:
        return int(av['N']) if '.' not in av['N'] else float(av['N'])
    if 'S' in av:
        return av['S']
    if 'BOOL' in av:
        return av['BOOL']
    return av


def unwrap_item(item):
    return {k: unwrap(v) for k, v in item.items()}


def build_standings_items(entry_gw_items, season=SEASON, gameweek=TARGET_GW, synced_at=None):
    """
    Pure function: given already-unwrapped fpl_entry_gameweek items (all for the
    same gameweek), returns the list of fpl_league_standings items to write.
    Kept separate from the AWS I/O so it can be unit tested without a live table.
    """
    if synced_at is None:
        synced_at = datetime.now(timezone.utc).isoformat()

    standings = []
    for item in entry_gw_items:
        standings.append({
            'season_event': f'{season}#{gameweek}',
            'manager_id': item['entry_id'],
            # Renamed 2026-08-14 from manager_name/team_name -- see DATA_MODEL.md's
            # identity redesign notes.
            'real_name': item.get('real_name', 'Unknown'),
            'team_nickname': item.get('team_nickname', 'Unknown'),
            'total_points': int(item.get('points_total', 0)),
            'points_this_week': int(item.get('points_this_week', 0)),
            'transfer_cost': int(item.get('transfer_cost', 0)),
            'rank': 0,
            'last_synced': synced_at,
            'backfilled': True,
            'backfill_source': 'fpl_entry_gameweek',
        })
    return standings


def to_dynamo_item(standings_item):
    return {
        'season_event': {'S': standings_item['season_event']},
        'manager_id': {'N': str(standings_item['manager_id'])},
        'real_name': {'S': standings_item['real_name']},
        'team_nickname': {'S': standings_item['team_nickname']},
        'total_points': {'N': str(standings_item['total_points'])},
        'points_this_week': {'N': str(standings_item['points_this_week'])},
        'transfer_cost': {'N': str(standings_item['transfer_cost'])},
        'rank': {'N': str(standings_item['rank'])},
        'last_synced': {'S': standings_item['last_synced']},
        'backfilled': {'BOOL': standings_item['backfilled']},
        'backfill_source': {'S': standings_item['backfill_source']},
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--apply', action='store_true', help='Actually write to DynamoDB (default is dry-run)')
    args = parser.parse_args()

    print(f"Scanning fpl_entry_gameweek for gameweek={TARGET_GW}...")
    scan_result = aws_json([
        'dynamodb', 'scan',
        '--table-name', 'fpl_entry_gameweek',
        '--filter-expression', 'gameweek = :gw',
        '--expression-attribute-values', json.dumps({':gw': {'N': str(TARGET_GW)}})
    ])
    entry_gw_items = [unwrap_item(i) for i in scan_result.get('Items', [])]
    print(f"Found {len(entry_gw_items)} manager records for GW{TARGET_GW} in fpl_entry_gameweek\n")

    if not entry_gw_items:
        print("Nothing to backfill -- no GW26 records found in fpl_entry_gameweek either.")
        sys.exit(0)

    standings_items = build_standings_items(entry_gw_items)

    for s in standings_items:
        print(f"  {s['real_name']} (id={s['manager_id']}): "
              f"total_points={s['total_points']}, points_this_week={s['points_this_week']}, "
              f"transfer_cost={s['transfer_cost']}")

    if args.apply:
        for s in standings_items:
            aws_json([
                'dynamodb', 'put-item',
                '--table-name', 'fpl_league_standings',
                '--item', json.dumps(to_dynamo_item(s))
            ])
        print(f"\nDone. Wrote {len(standings_items)} items to fpl_league_standings for {SEASON}#{TARGET_GW}.")
    else:
        print(f"\nDRY RUN -- nothing written. Re-run with --apply to commit these {len(standings_items)} items.")


if __name__ == '__main__':
    main()
