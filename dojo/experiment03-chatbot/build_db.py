"""Build a synthetic, PII-free SQLite fleet dataset with deterministic ground truth.
All durations are precomputed integers (no wall-clock dependence)."""
import sqlite3, os

DB = os.path.join(os.path.dirname(__file__), "fleet.db")
if os.path.exists(DB):
    os.remove(DB)
c = sqlite3.connect(DB)
q = c.executescript

q("""
CREATE TABLE company (company_id TEXT PRIMARY KEY, name TEXT);
CREATE TABLE app_user (user_id TEXT PRIMARY KEY, company_id TEXT, access_type TEXT); -- FULL_ACCESS | SCOPED
CREATE TABLE user_grant (user_id TEXT, truck_id TEXT);                               -- SCOPED users only
CREATE TABLE truck (truck_id TEXT PRIMARY KEY, company_id TEXT, fleet_group TEXT, name TEXT, active INTEGER);
CREATE TABLE location (company_id TEXT, name TEXT);
CREATE TABLE current_status (truck_id TEXT, location TEXT, status TEXT, duration_min INTEGER);
CREATE TABLE stop_event (truck_id TEXT, location TEXT, duration_min INTEGER, day TEXT); -- last-7-days loading events
CREATE TABLE route_stop (truck_id TEXT, day TEXT, seq INTEGER, location TEXT, kind TEXT, sched TEXT, status TEXT);
""")

company = [("COMP001", "Alpha Freight"), ("COMP002", "Beta Haulage")]
app_user = [("USER001", "COMP001", "FULL_ACCESS"),
            ("USER002", "COMP001", "SCOPED"),
            ("USER500", "COMP002", "FULL_ACCESS")]
user_grant = [("USER002", "T123"), ("USER002", "T124"), ("USER002", "T125")]  # SCOPED: only these
truck = [("T123", "COMP001", "Alpha", "Freightliner 123", 1),
         ("T124", "COMP001", "Alpha", "Volvo 124", 1),
         ("T125", "COMP001", "Alpha", "Kenworth 125", 1),
         ("T126", "COMP001", "Beta",  "Peterbilt 126", 1),
         ("T500", "COMP002", "Main",  "Scania 500", 1)]   # different company -> isolation test
location = [("COMP001", "Warehouse A"), ("COMP001", "Warehouse B"),
            ("COMP001", "Main Depot"), ("COMP001", "Customer A"), ("COMP001", "Customer B"),
            ("COMP002", "Depot Z")]
current_status = [("T123", "Warehouse A", "parked", 120),
                  ("T124", "Warehouse A", "loading", 45),
                  ("T125", "Warehouse A", "parked", 15),
                  ("T126", "Main Depot", "parked", 200),
                  ("T500", "Depot Z", "parked", 60)]
# Warehouse A dwell events for COMP001 trucks -> AVG = (30+45+60+45+30+60)/6 = 45.0  (clean ground truth)
stop_event = [("T123", "Warehouse A", 30, "2026-07-02"), ("T123", "Warehouse A", 60, "2026-07-04"),
              ("T124", "Warehouse A", 45, "2026-07-03"), ("T124", "Warehouse A", 30, "2026-07-05"),
              ("T125", "Warehouse A", 60, "2026-07-06"), ("T125", "Warehouse A", 45, "2026-07-07"),
              ("T126", "Main Depot", 200, "2026-07-06")]
route_stop = [  # T123 route on latest day
    ("T123", "2026-07-08", 1, "Main Depot", "START",    "06:00", "COMPLETED"),
    ("T123", "2026-07-08", 2, "Customer A", "DELIVERY", "07:30", "COMPLETED"),
    ("T123", "2026-07-08", 3, "Warehouse A", "LOADING", "08:30", "IN_PROGRESS"),
    ("T123", "2026-07-08", 4, "Customer B", "DELIVERY", "14:00", "SCHEDULED"),
    ("T123", "2026-07-08", 5, "Warehouse B", "LOADING", "15:00", "SCHEDULED"),
    ("T123", "2026-07-08", 6, "Main Depot", "END",      "16:00", "SCHEDULED")]

c.executemany("INSERT INTO company VALUES (?,?)", company)
c.executemany("INSERT INTO app_user VALUES (?,?,?)", app_user)
c.executemany("INSERT INTO user_grant VALUES (?,?)", user_grant)
c.executemany("INSERT INTO truck VALUES (?,?,?,?,?)", truck)
c.executemany("INSERT INTO location VALUES (?,?)", location)
c.executemany("INSERT INTO current_status VALUES (?,?,?,?)", current_status)
c.executemany("INSERT INTO stop_event VALUES (?,?,?,?)", stop_event)
c.executemany("INSERT INTO route_stop VALUES (?,?,?,?,?,?,?)", route_stop)
c.commit()
c.close()
print("built", DB)
