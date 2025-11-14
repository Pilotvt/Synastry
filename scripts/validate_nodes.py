# A validation script to compare computed node positions with eclipse observations
from datetime import datetime
import json
from pathlib import Path
import sys
from pathlib import Path
sys.path.append(str(Path(__file__).resolve().parents[1]))

from app.nodes import calculate_nodes
import pandas as pd

def load_eclipse_data():
    """Load eclipse observations data."""
    data_file = Path(__file__).resolve().parents[1] / 'data' / 'eclipse_nodes.json'
    with open(data_file, 'r', encoding='utf-8') as f:
        data = json.load(f)
    return data['nodes']

def validate_nodes():
    """Compare computed node positions against eclipse observations."""
    eclipse_data = load_eclipse_data()
    
    results = []
    for entry in eclipse_data:
        dt = datetime.fromisoformat(entry['datetime_iso'])
        rahu, ketu = calculate_nodes(dt)
        
        # Find the actual observed longitude for this node
        expected = entry['node_longitude']
        if entry['node'] == 'Rahu':
            computed = rahu
        else:  # Ketu
            computed = ketu
        
        diff = abs(((computed - expected + 180.0) % 360.0) - 180.0)
        
        results.append({
            'datetime': entry['datetime_iso'],
            'node': entry['node'],
            'expected': expected,
            'computed': computed,
            'diff_deg': diff,
            'eclipse_type': entry['eclipse_type']
        })
    
    # Convert to DataFrame for easier analysis
    df = pd.DataFrame(results)
    
    # Print summary statistics
    print("\nValidation Summary:")
    print(f"Total observations: {len(df)}")
    print("\nError statistics (degrees):")
    print(df['diff_deg'].describe())
    
    print("\nLargest discrepancies:")
    print(df.nlargest(5, 'diff_deg'))
    
    # Save detailed results
    output_file = Path(__file__).resolve().parent / 'node_validation_results.csv'
    df.to_csv(output_file, index=False)
    print(f"\nDetailed results saved to: {output_file}")

if __name__ == '__main__':
    validate_nodes()