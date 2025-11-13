"""Calculate node positions using eclipse observations."""
from datetime import datetime
import json
from bisect import bisect_right
from .resource_paths import resource_path

def load_eclipse_nodes():
    """Load eclipse node observations from JSON."""
    data_file = resource_path('data', 'eclipse_nodes.json')

    with open(data_file, 'r', encoding='utf-8') as f:
        data = json.load(f)
    
    # Convert ISO strings to datetime objects for easier searching
    from datetime import timezone
    for entry in data['nodes']:
        dt = datetime.fromisoformat(entry['datetime_iso'])
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        entry['datetime'] = dt
    
    return data['nodes']

def calculate_node_position(dt: datetime, nodes=None):
    """Calculate node position by interpolating between eclipse observations."""
    if nodes is None:
        nodes = load_eclipse_nodes()
    
    # Filter nodes by type (Rahu/Ketu)
    rahu_nodes = [n for n in nodes if n['node'] == 'Rahu']
    ketu_nodes = [n for n in nodes if n['node'] == 'Ketu']
    
    def interpolate_between_nodes(dt: datetime, node_list: list):
        # Find index where the target datetime would be inserted to maintain sorted order
        idx = bisect_right([n['datetime'] for n in node_list], dt)
        
        if idx == 0:
            # Before first eclipse - use first known position
            return node_list[0]['node_longitude']
        elif idx == len(node_list):
            # After last eclipse - use last known position
            return node_list[-1]['node_longitude']
        else:
            # Interpolate between surrounding eclipses
            prev_node = node_list[idx - 1]
            next_node = node_list[idx]
            
            # Time delta weighting
            td_prev = (dt - prev_node['datetime']).total_seconds()
            td_total = (next_node['datetime'] - prev_node['datetime']).total_seconds()
            weight = td_prev / td_total
            
            # Handle crossing 360° boundary
            lon_prev = prev_node['node_longitude']
            lon_next = next_node['node_longitude']
            
            # If crossing 360° -> 0°, adjust next value up
            if lon_next < lon_prev and lon_prev - lon_next > 180:
                lon_next += 360
            # If crossing 0° -> 360°, adjust prev value up
            elif lon_next > lon_prev and lon_next - lon_prev > 180:
                lon_prev += 360
                
            # Linear interpolation
            lon = lon_prev + (lon_next - lon_prev) * weight
            
            # Normalize to 0-360
            return lon % 360
    
    # Calculate position from corresponding node type observations
    if len(rahu_nodes) > 0 and len(ketu_nodes) > 0:
        rahu_pos = interpolate_between_nodes(dt, rahu_nodes)
        ketu_pos = interpolate_between_nodes(dt, ketu_nodes)
        return rahu_pos
    else:
        # Fallback to using any node observations if one type is missing
        pos = interpolate_between_nodes(dt, nodes)
        return pos

def calculate_nodes(dt: datetime):
    """Calculate both Rahu and Ketu positions for a given datetime."""
    nodes = load_eclipse_nodes()
    
    rahu_lon = calculate_node_position(dt, nodes)
    ketu_lon = (rahu_lon + 180) % 360
    
    return rahu_lon, ketu_lon