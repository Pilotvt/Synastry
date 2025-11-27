"""Parse eclipse_table.txt into JSON structure for use in node calculations."""
import re
import json
from datetime import datetime
from pathlib import Path

def parse_eclipse_line(line: str):
    """Parse one line of eclipse_table.txt into structured dict."""
    parts = [p.strip() for p in line.split('|')]
    if len(parts) != 8:
        return None
    
    try:
        dt = datetime.strptime(parts[0], '%Y-%m-%d %H:%M:%S')
        eclipse_type = parts[1]  # Solar/Lunar
        node_label = parts[2].replace('Node ', '')  # Rahu/Ketu
        node_const = parts[3].strip()
        body_const = parts[4].strip()  # Sun/Moon constellation
        # Clean up longitude strings by removing field names
        node_lon = float(parts[5].split()[-1].replace('°', '').strip())
        body_lon = float(parts[6].split()[-1].replace('°', '').strip())
        moon_lat = float(parts[7].split()[-1].replace('°', '').strip())

        return {
            'datetime_iso': dt.strftime('%Y-%m-%dT%H:%M:%S'),
            'eclipse_type': eclipse_type,
            'node': node_label,
            'node_constellation': node_const,
            'body_constellation': body_const,
            'node_longitude': node_lon,
            'body_longitude': body_lon,
            'moon_latitude': moon_lat
        }
    except (ValueError, IndexError) as e:
        print(f'Error parsing line: {line}')
        print(f'Error: {e}')
        return None

def main():
    root = Path(__file__).resolve().parents[1]
    input_file = root / 'eclipse_table.txt'
    output_file = root / 'data' / 'eclipse_nodes.json'

    if not input_file.exists():
        print(f'Input file not found: {input_file}')
        return

    # Create data dir if needed
    output_file.parent.mkdir(exist_ok=True)

    with open(input_file, 'r', encoding='utf-8') as f:
        lines = f.readlines()

    nodes = []
    for line in lines:
        line = line.strip()
        if not line:
            continue
        
        entry = parse_eclipse_line(line)
        if entry:
            nodes.append(entry)

    # Sort by datetime
    nodes.sort(key=lambda x: x['datetime_iso'])

    with open(output_file, 'w', encoding='utf-8') as f:
        json.dump({'nodes': nodes}, f, ensure_ascii=False, indent=2)

    print(f'Processed {len(nodes)} eclipse entries')
    print(f'Output written to: {output_file}')

if __name__ == '__main__':
    main()