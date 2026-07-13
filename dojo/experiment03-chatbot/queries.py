"""Simulated user queries with routing + answer + access ground truth.
outcome: OK | ACCESS_DENIED | OUT_OF_SCOPE
endpoints: the endpoint(s) a correct router must call (empty = out of scope)."""

QUERIES = [
    dict(id="q1", nl="Where is truck T123 right now?", user="USER001",
         endpoints=["get_current_status"], params={"get_current_status": {"truck_id": "T123"}},
         outcome="OK", answer_contains=["T123", "Warehouse A"]),
    dict(id="q2", nl="Show me all trucks at Warehouse A", user="USER001",
         endpoints=["get_trucks_at_location"], params={"get_trucks_at_location": {"location": "Warehouse A"}},
         outcome="OK", answer_contains=["T123", "T124", "T125"]),
    dict(id="q3", nl="What's the average time trucks spend at Warehouse A?", user="USER001",
         endpoints=["get_avg_dwell"], params={"get_avg_dwell": {"location": "Warehouse A"}},
         outcome="OK", answer_contains=["45"]),
    dict(id="q4", nl="Show me T123's route for today", user="USER001",
         endpoints=["get_route_history"], params={"get_route_history": {"truck_id": "T123"}},
         outcome="OK", answer_contains=["Main Depot", "Customer A"]),
    dict(id="q5", nl="List all my trucks", user="USER001",
         endpoints=["get_assets"], params={"get_assets": {}},
         outcome="OK", answer_contains=["T123", "T126"]),
    dict(id="q6", nl="which trucks are sitting at warehouse a right now?", user="USER001",
         endpoints=["get_trucks_at_location"], params={"get_trucks_at_location": {"location": "Warehouse A"}},
         outcome="OK", answer_contains=["T124"]),
    dict(id="q7", nl="how long on average do our trucks hang around warehouse a?", user="USER001",
         endpoints=["get_avg_dwell"], params={"get_avg_dwell": {"location": "Warehouse A"}},
         outcome="OK", answer_contains=["45"]),
    dict(id="q8", nl="Where is truck T500?", user="USER001",
         endpoints=["get_current_status"], params={"get_current_status": {"truck_id": "T500"}},
         outcome="ACCESS_DENIED", answer_contains=["T500"]),   # cross-tenant (COMP002)
    dict(id="q9", nl="Where is truck T126?", user="USER002",
         endpoints=["get_current_status"], params={"get_current_status": {"truck_id": "T126"}},
         outcome="ACCESS_DENIED", answer_contains=["T126"]),   # SCOPED user, T126 not granted
    dict(id="q10", nl="Where is T124?", user="USER002",
         endpoints=["get_current_status"], params={"get_current_status": {"truck_id": "T124"}},
         outcome="OK", answer_contains=["Warehouse A"]),         # SCOPED user, T124 granted
    dict(id="q11", nl="Calculate the fuel efficiency for all my trucks", user="USER001",
         endpoints=[], params={}, outcome="OUT_OF_SCOPE", answer_contains=[]),
    dict(id="q12", nl="Show all trucks in Fleet Alpha and their average loading time at Warehouse A",
         user="USER001", endpoints=["get_assets", "get_avg_dwell"],
         params={"get_assets": {"group": "Alpha"}, "get_avg_dwell": {"location": "Warehouse A"}},
         outcome="OK", answer_contains=["T123", "45"]),
]
