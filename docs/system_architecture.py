import html as H

# ---- palette taken from the original figure ----
PRES_F, PRES_S = "#e3f0fb", "#708fae"
API_F, API_S = "#eef3e2", "#8aa36a"
SVC_F, SVC_S = "#e6f4e6", "#6f9c6f"
DATA_F, DATA_S = "#fdf1e0", "#d2a05c"
INTG_F, INTG_S = "#f3ecf7", "#a284b8"
EXT_F, EXT_S = "#eef3f6", "#9aa7ae"
LEG_F, LEG_S = "#f7f9fa", "#c9d2d7"
BOXS = "#5c6670"
TXT = "#222"
CLS = "#476d46"
ARROW = "#333"
TAG = "#8a6a2f"
RED = "#a33"

E = H.escape


class SVG:
    def __init__(self, w, h):
        self.w, self.h, self.o = w, h, []

    def band(self, x, y, w, h, fill, stroke, title, sub=None, dashed=False):
        da = ' stroke-dasharray="7 5"' if dashed else ""
        self.o.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="7" fill="{fill}" stroke="{stroke}" stroke-width="1.5"{da}/>')
        if title:
            self.o.append(f'<text x="{x+16}" y="{y+23}" font-size="14.5" font-weight="bold" fill="{TXT}">{E(title)}</text>')
        if sub:
            tw = len(title) * 8.2 + 26
            self.o.append(f'<text x="{x+tw}" y="{y+23}" font-size="10.5" fill="#667">{E(sub)}</text>')

    def box(self, x, y, w, h, title, lines=(), center=False, dashed=False, fill="#fff", stroke=None):
        s = stroke or BOXS
        da = ' stroke-dasharray="5 4"' if dashed else ""
        self.o.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="4" fill="{fill}" stroke="{s}" stroke-width="1.2"{da}/>')
        if center:
            self.o.append(f'<text x="{x+w/2}" y="{y+h/2+4.5}" text-anchor="middle" font-size="12.5" font-weight="bold" fill="{TXT}">{E(title)}</text>')
            return
        self.o.append(f'<text x="{x+11}" y="{y+19}" font-size="12" font-weight="bold" fill="{TXT}">{E(title)}</text>')
        yy = y + 35
        for ln in lines:
            self.o.append(f'<text x="{x+11}" y="{yy}" font-size="10" fill="{CLS}">{E(ln)}</text>')
            yy += 14

    def cyl(self, cx, y, w, h, title, sub):
        x, ry = cx - w / 2, 9
        self.o.append(f'<path d="M{x},{y+ry} v{h-2*ry} a{w/2},{ry} 0 0 0 {w},0 v-{h-2*ry} a{w/2},{ry} 0 0 0 -{w},0 a{w/2},{ry} 0 0 0 {w},0" fill="#fff4e0" stroke="{DATA_S}" stroke-width="1.3"/>')
        self.o.append(f'<text x="{cx}" y="{y+h/2+2}" text-anchor="middle" font-size="12" font-weight="bold" fill="{TXT}">{E(title)}</text>')
        self.o.append(f'<text x="{cx}" y="{y+h/2+16}" text-anchor="middle" font-size="10" fill="#667">{E(sub)}</text>')

    def arrow(self, x1, y1, x2, y2, dashed=False):
        da = ' stroke-dasharray="6 4"' if dashed else ""
        self.o.append(f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{ARROW}" stroke-width="1.4"{da} marker-end="url(#a)"/>')

    def txt(self, x, y, s, size=10.5, anchor="start", color=TXT, italic=False, bold=False):
        st = ' font-style="italic"' if italic else ""
        b = ' font-weight="bold"' if bold else ""
        self.o.append(f'<text x="{x}" y="{y}" font-size="{size}" text-anchor="{anchor}" fill="{color}"{st}{b}>{E(s)}</text>')

    def tag(self, x, y, s):
        self.o.append(f'<rect x="{x}" y="{y-9}" width="{len(s)*6.6+7}" height="13" rx="2.5" fill="#f3ead6" stroke="#d9c9a6" stroke-width="0.8"/>')
        self.o.append(f'<text x="{x+4}" y="{y+1}" font-size="9" font-weight="bold" fill="{TAG}">{E(s)}</text>')

    def boundary_icon(self, x, y):
        self.o.append(f'<g stroke="{RED}" stroke-width="1.5" fill="none"><line x1="{x}" y1="{y-7}" x2="{x}" y2="{y+7}"/><line x1="{x}" y1="{y}" x2="{x+7}" y2="{y}"/><circle cx="{x+13}" cy="{y}" r="6.5"/></g>')

    def control_icon(self, x, y):
        self.o.append(f'<g stroke="{RED}" stroke-width="1.5" fill="none"><circle cx="{x}" cy="{y}" r="6.5"/><path d="M{x-1},{y-6.5} l4,-3 l0.5,4.5" stroke-linejoin="round"/></g>')

    def entity_icon(self, x, y):
        self.o.append(f'<g stroke="{RED}" stroke-width="1.5" fill="none"><circle cx="{x}" cy="{y-1}" r="6.5"/><line x1="{x-7}" y1="{y+8}" x2="{x+7}" y2="{y+8}"/></g>')

    def svg(self):
        d = (f'<defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">'
             f'<path d="M0,0 L10,5 L0,10 z" fill="{ARROW}"/></marker></defs>')
        return (f'<svg viewBox="0 0 {self.w} {self.h}" xmlns="http://www.w3.org/2000/svg" '
                f'font-family="Arial, Liberation Sans, sans-serif">{d}' + "".join(self.o) + "</svg>")


def figure1():
    s = SVG(1180, 1010)
    s.txt(590, 22, "System Architecture — Dialysis Transport Coordination System", 15, "middle", bold=True)

    # ---------- Presentation ----------
    s.band(20, 40, 1140, 142, PRES_F, PRES_S, "Presentation Layer", "React + TypeScript + Vite (web browser)")
    s.boundary_icon(1120, 58)
    pw, px = 268, [35, 318, 601, 884]
    s.box(px[0], 70, pw, 100, "Shared Entry UI",
          ["Login · Create Account · Complete Details", "Select Patient · My Account"])
    s.box(px[1], 70, pw, 100, "Coordinator UI",
          ["Coordinator Trips · Coordinator Trip Details", "Coordinator Schedules · Generate Trips",
           "Patients · Patient Details · Caregivers", "Drivers · Match a Driver · Recovery Options",
           "Route & Traffic Monitor · Audit Log"])
    s.box(px[2], 70, pw, 100, "Driver UI",
          ["Driver Trips · Driver Trip Details", "Driver Availability · My Vehicle"])
    s.box(px[3], 70, pw, 100, "Patient & Caregiver UI",
          ["Patient Trips · Patient Trip Details", "Patient Schedules · Caregiver Connections",
           "Add Reminder", "Rate Driver · Preferred Driver  (Patient only)"])

    # ---------- Presentation <-> API ----------
    # C6 is repeated C1 requests, so both share one arrow
    # C1 lands on REST Controllers: requests reach a controller first
    s.arrow(340, 182, 340, 256)
    s.txt(350, 208, "HTTPS REST / JSON", 10.5)
    s.tag(458, 208, "C1")
    s.txt(350, 230, "incl. polling every 5–30 s", 10.5)
    s.tag(500, 230, "C6")

    # sign-in: the browser is redirected to Supabase Auth and Google, outside the API Layer
    s.box(40, 198, 170, 44, "Supabase Auth", ["Google identity provider"], dashed=True, fill=EXT_F, stroke=EXT_S)
    s.o.append(f'<line x1="125" y1="171" x2="125" y2="197" stroke="{ARROW}" stroke-width="1.4" '
               f'marker-start="url(#a)" marker-end="url(#a)"/>')
    s.txt(220, 214, "OAuth 2.0 sign-in", 10.5)
    s.tag(220, 231, "C9")

    # ---------- Application server ----------
    s.band(20, 258, 1140, 352, "none", "#8a8f94", None, dashed=True)
    s.txt(1148, 276, "Application Server — NestJS + TypeScript (Render)", 10.5, "end", color="#667", italic=True)

    s.band(35, 284, 1110, 88, API_F, API_S, "API Layer")
    s.boundary_icon(1105, 302)
    s.box(50, 320, 1080, 36, "REST Controllers", center=True)

    s.arrow(340, 356, 340, 408)
    s.txt(350, 388, "calls services", 10.5)
    s.tag(418, 388, "C2")

    s.band(35, 410, 1110, 186, SVC_F, SVC_S, "Service Layer",
           "each service first verifies the login token and validates input")
    s.control_icon(1110, 428)
    # C5: two controls start their own timers when the server starts
    s.txt(1052, 433, "in-process timers", 10.5, "end", italic=True, color="#667")
    s.tag(1058, 433, "C5")
    sb = [
        (50, 440, "Access", ["AuthenticationControl", "ProfileManagerControl"]),
        (415, 440, "Scheduling", ["ScheduleControl · AvailabilityControl", "TripControl"]),
        (780, 440, "Operations & Recovery", ["MonitoringControl (timer, every 15 s) · TrackingControl", "RiskRecoveryControl · RouteAssessmentControl"]),
        (50, 516, "Patient Services", ["FeedbackAndPreferenceControl", "CalendarSyncControl (timer, every 30 s)"]),
        (415, 516, "Notification", ["NotificationControl"]),
        (780, 516, "Audit", ["TripHistoryControl"]),
    ]
    for x, y, t, l in sb:
        s.box(x, y, 350, 66, t, l)

    # ---------- down to Data / Integration ----------
    s.txt(440, 628, "rpc() with user's token", 10.5)
    s.tag(570, 628, "C3")
    s.txt(675, 628, "secret key", 10.5)
    s.tag(733, 628, "C7")
    s.arrow(830, 610, 830, 650)
    s.txt(840, 628, "external requests", 10.5)
    s.tag(936, 628, "C4")

    # ---------- Data layer ----------
    s.band(20, 652, 660, 248, DATA_F, DATA_S, "Data Layer")
    s.entity_icon(652, 672)
    s.box(35, 684, 300, 92, "Entities (mapped to tables)",["Transport Coordinator · Patient · Caregiver",
                                                   "Driver · Vehicle · Trip · TreatmentSlot · TripLog",
                                                   "TrafficDisruption · … — 18 in all (class diagram)"])
    s.box(348, 684, 297, 92, "SQL Functions + RLS", ["Business rules, role and ownership checks;",
                                                     "called through supabase-js rpc();",
                                                     "each function is one transaction"])
    # both boxes live in the database
    s.arrow(250, 776, 250, 803)
    s.arrow(430, 776, 430, 806)
    s.cyl(340, 800, 320, 80, "Supabase PostgreSQL", "tables, functions and policies")
    # C3 and C7 are drawn after the band so its fill does not hide them
    s.arrow(430, 610, 430, 682)
    # C7 bypasses RLS, so it goes around the SQL Functions + RLS box straight to the database
    s.o.append(f'<polyline points="667,610 667,840 502,840" fill="none" stroke="{ARROW}" stroke-width="1.4" '
               f'stroke-dasharray="6 4" marker-end="url(#a)"/>')

    # ---------- Integration layer ----------
    s.band(700, 652, 250, 248, INTG_F, INTG_S, "Integration Layer")
    s.txt(862, 675, "«Adapter»", 10, italic=True, color="#667")
    ad = [("OneMapAdapter", 690), ("LtaDataMallAdapter", 740), ("GoogleCalendarAdapter", 790)]
    for t, y in ad:
        s.box(714, y, 222, 38, t, center=True)
    # external
    s.txt(1070, 668, "External systems", 10.5, "middle", italic=True, color="#667")
    ex = [("OneMap API", 690), ("LTA DataMall", 740), ("Google Calendar API", 790)]
    for t, y in ex:
        s.box(978, y, 185, 38, t, center=True, dashed=True, fill=EXT_F, stroke=EXT_S)
    for _, y in ad:
        s.arrow(938, y + 19, 976, y + 19)
    s.txt(953, 684, "HTTPS", 9, color="#667")
    s.tag(955, 775, "C8")

    # ---------- Legend ----------
    s.band(20, 918, 1140, 80, LEG_F, LEG_S, None)
    s.o.append(f'<line x1="40" y1="944" x2="98" y2="944" stroke="{ARROW}" stroke-width="1.4" marker-end="url(#a)"/>')
    s.txt(106, 948, "Request or call (synchronous)", 10.5)
    s.o.append(f'<line x1="400" y1="944" x2="458" y2="944" stroke="{ARROW}" stroke-width="1.4" stroke-dasharray="6 4" marker-end="url(#a)"/>')
    s.txt(466, 948, "Secret-key access (bypasses RLS)", 10.5)
    s.tag(730, 948, "C1")
    s.txt(760, 948, "Connector, defined in Section 4", 10.5)
    s.boundary_icon(948, 944)
    s.txt(972, 948, "boundary", 10.5)
    s.control_icon(1040, 944)
    s.txt(1052, 948, "control", 10.5)
    s.entity_icon(1110, 944)
    s.txt(1122, 948, "entity", 10.5)
    s.txt(40, 976, "Dashed outer box = one deployed process. Services in the same layer may call each other. "
                   "Deployment: frontend and backend on Render; database and authentication on Supabase Cloud.", 10)
    return s.svg()


# ================= document =================
CSS = """
@page { size: A4; margin: 17mm 16mm 17mm 17mm; }
body { font-family: Arial, 'Liberation Sans', sans-serif; font-size: 10.4pt; color: #222; line-height: 1.45; }
h1 { font-size: 24pt; margin: 0 0 4pt; }
.sub { color: #777; font-size: 9.8pt; margin-bottom: 4pt; }
h2 { font-size: 15.5pt; margin: 18pt 0 7pt; page-break-after: avoid; }
h3 { font-size: 11.6pt; margin: 13pt 0 4pt; page-break-after: avoid; }
ul { margin: 4pt 0; padding-left: 16pt; }
li { margin: 2.5pt 0; }
code { white-space: nowrap; font-family: Consolas, 'DejaVu Sans Mono', monospace; font-size: 8.8pt;
       background: #f0f0f0; padding: 0 3px; border-radius: 3px; }
hr { border: none; border-top: 1px solid #ccc; margin: 13pt 0; }
.fig { margin: 7pt 0 3pt; page-break-inside: avoid; }
.fig svg { width: 100%; height: auto; display: block; }
.cap { text-align:center; font-size:9.4pt; color:#666; margin-bottom:4pt; }
table { border-collapse: collapse; width: 100%; font-size: 8.9pt; margin-top: 6pt; }
th, td { border: 1px solid #cfcfcf; padding: 3.5pt 5pt; text-align: left; vertical-align: top; }
th { background: #eef1ee; }
tr { page-break-inside: avoid; }
thead { display: table-header-group; }
.sec { page-break-inside: avoid; }
.pb { page-break-before: always; }
.note { background:#fbf7ec; border:1px solid #e3d7bb; border-radius:4px; padding:7pt 10pt; margin:9pt 0; font-size:9.6pt; }
.note b { color:#7a5e22; }
"""


def row(*c):
    return "<tr>" + "".join(f"<td>{x}</td>" for x in c) + "</tr>"


def table(heads, rows):
    h = "<tr>" + "".join(f"<th>{x}</th>" for x in heads) + "</tr>"
    return f"<table><thead>{h}</thead><tbody>{''.join(rows)}</tbody></table>"


LAYERS = table(["Layer", "Stereotype", "Role"], [
    row("Presentation (browser)", "boundary", "Screens for each role, matching the Dialog Map. Sends a request for every user action and displays the result."),
    row("API Layer (server)", "boundary", "Receives requests and hands them to a service, whose first step checks the login token and validates input. Contains no business logic. The <code>Application</code> class of the design class diagram is the server entry point that starts this layer."),
    row("Service Layer (server)", "control", "Coordinates each task: calls the SQL function for the operation and any external adapters it needs. Each service is a control class from the design class diagram."),
    row("Data Layer", "entity","PostgreSQL tables for the entities, with the SQL functions and Row-Level Security policies that enforce business rules and access control."),
    row("Integration Layer", "adapter", "One adapter per external service, used by the Service Layer alongside the Data Layer."),
])

COMPONENTS = table(["Component", "Responsibility", "Implemented in", "Traces to"], [
    row("Shared Entry UI", "Login; two-step signup (Create Account, Complete Details); Account Inactive; Select Patient for Caregivers linked to more than one Patient; My Account.", "frontend <code>features/auth</code>, <code>features/profiles</code>", "UC-01; Dialog Map — Shared Entry"),
    row("Coordinator UI", "Coordinator Trips and Coordinator Trip Details, Coordinator Schedules and Generate Trips, Patients and Patient Details, Caregivers, Drivers, driver matching, recovery options, route &amp; traffic monitor, audit log.", "frontend <code>features/*</code> pages", "UC-02 to UC-05, UC-08; Dialog Map — Coordinator"),
    row("Driver UI", "Driver Trips and Driver Trip Details, Driver Availability, My Vehicle, Confirm Unavailability. While a trip is active, the driver's trip screen sends the live location in the background, so the Dialog Map needs no separate state for it.", "frontend <code>features/trips</code>, <code>features/availability</code>, <code>features/drivers</code>", "UC-06, UC-07, UC-09, UC-10; Dialog Map — Driver"),
    row("Patient &amp; Caregiver UI", "Patient Trips and Patient Trip Details, which show live tracking within the page rather than on a separate screen; Patient Schedules; Caregiver Connections; confirm / cancel trip, rate and preferred driver (Patient only), add reminder.", "frontend <code>features/trips</code>, <code>features/treatments</code>, <code>features/caregivers</code>, <code>features/calendar</code>", "UC-02.1, UC-03, UC-09, UC-10, UC-11, UC-11.1, UC-12, UC-13; Dialog Map — Patient &amp; Caregiver"),
    row("REST Controllers", "One endpoint per user action, e.g. <code>PATCH /trips/:id/cancel</code>.", "<code>*.controller.ts</code> in each module", "All use cases"),
    row("Timers", "Two control classes start their own in-process timers when the server starts. The traffic monitor (<code>MonitoringControl</code>) runs every 15 seconds. It claims assigned trips that are in progress, or whose pickup is between one day ago and one hour from now, assesses route and traffic, and flags trips at risk. It then claims trips that need recovery and generates recovery options for them automatically (UC-05.1). The calendar sync (<code>CalendarSyncControl</code>) runs every 30 seconds and publishes queued reminder changes to each connected user's Google Calendar.", "<code>trips</code> (traffic monitor); <code>integrations</code> (calendar sync)", "UC-05, UC-05.1, UC-08, UC-13; NFR-2.1, NFR-3.2"),
    row("Access", "<code>AuthenticationControl</code>, <code>ProfileManagerControl</code>: login, profile records, Caregiver-Patient links.", "<code>auth</code>, <code>profiles</code>", "UC-01, UC-02, UC-02.1"),
    row("Scheduling", "<code>ScheduleControl</code>, <code>AvailabilityControl</code>, <code>TripControl</code>: recurring trips, driver and vehicle assignment, availability, confirmation and cancellation.", "<code>scheduling</code>, <code>drivers</code>, <code>trips</code>", "UC-03, UC-03.1, UC-06, UC-07, UC-11, UC-11.1"),
    row("Operations &amp; Recovery", "<code>MonitoringControl</code>, <code>TrackingControl</code>, <code>RiskRecoveryControl</code>, <code>RouteAssessmentControl</code>: trip status, live tracking, recovery options, route and ETA.", "<code>trips</code>, using <code>integrations</code>", "UC-04, UC-05, UC-05.1, UC-08, UC-09"),
    row("Patient Services", "<code>FeedbackAndPreferenceControl</code>, <code>CalendarSyncControl</code>: ratings, preferred driver, calendar reminders.", "<code>trips</code>; <code>integrations</code> (calendar)", "UC-12, UC-13"),
    row("Notification", "<code>NotificationControl</code>: records notifications for the affected users, which their browsers fetch by polling.", "<code>trips</code>", "UC-10"),
    row("Audit", "<code>TripHistoryControl</code>: records assignments, disruptions, recoveries, cancellations and final status; serves the Audit Log.", "<code>trips</code>", "UC-04.AF2; FR-6.4"),
    row("Entities", "The 18 entities of the design class diagram, mapped onto PostgreSQL tables. Most have their own table; some are part of another table, e.g. a Transport Coordinator is an account with the coordinator role. Rules about an entity are table constraints or checks inside the SQL functions that change it, e.g. a Trip can only be cancelled while upcoming.", "<code>database/schema.sql</code>", "Design class diagram"),
    row("SQL Functions + RLS", "Business operations run as SQL functions called through supabase-js <code>rpc()</code>; each runs as one transaction. Row-Level Security policies limit each user's reads to the rows they may see.", "<code>database/schema.sql</code>", "NFR-3.1, NFR-5.2, NFR-5.4"),
    row("Supabase PostgreSQL", "Relational database for all persistent data. The backend reaches it through supabase-js over HTTPS, normally with the user's token (C3) and for five specific uses with the secret key (C7).", "Supabase Cloud", "NFR-3.1"),
    row("Supabase Auth", "External identity service. The browser is redirected to it, and through it to Google, to sign in (C9); it verifies the Google identity and issues login tokens.", "Supabase Cloud", "UC-01; NFR-5.1"),
    row("Integration adapters", "OneMap, LTA DataMall and Google Calendar adapters over HTTPS. Each call times out after 5 seconds; bulk LTA fetches and route recalculation allow 10–20 seconds. OAuth 2.0 for Google Calendar.", "<code>integrations</code>", "UC-08, UC-13; NFR-2.1, NFR-7.1"),
])

CONNECTORS = table(["#", "Between", "Mechanism", "Direction and timing"], [
    row("C1", "Browser → API Layer", "HTTPS request carrying JSON, with the login token in the authorisation header", "Request-reply, synchronous. Every user action is one request."),
    row("C2", "API Layer → Service Layer", "Local method call inside the NestJS process", "Call-and-return, synchronous."),
    row("C3", "Service Layer → Data Layer (user)", "supabase-js over HTTPS: <code>rpc()</code> to a SQL function, or a table read, carrying the user's login token", "Request-reply, synchronous. RLS and the function's own checks apply as that user. Each function call is one transaction. The same client also verifies the login token with Supabase Auth."),
    row("C4", "Service Layer → Integration Layer", "Local method call on an adapter interface", "Call-and-return, synchronous, with a timeout (5 seconds per call)."),
    row("C5", "Timer → Service Layer", "In-process timers started by <code>MonitoringControl</code> (traffic monitor, every 15 seconds) and <code>CalendarSyncControl</code> (calendar sync, every 30 seconds) when the server starts", "Time-triggered, asynchronous. No user request is involved."),
    row("C6", "Browser → API Layer (polling)", "Repeated HTTPS requests on the C1 path: trip progress every 5 seconds; notifications and driver availability every 15 seconds; the trip list and the signed-in account every 30 seconds", "Request-reply, periodic. Keeps open screens current without a push channel."),
    row("C7", "Service Layer → Data Layer (secret key)", "supabase-js over HTTPS with the backend's secret key", "Request-reply, synchronous. Bypasses RLS, so it is limited to five uses: the shared route cache, recovery-option generation, the traffic monitor, Google Calendar connections and reminder sync, and demo mode."),
    row("C8", "Integration adapters → External APIs", "HTTPS over the public internet; OAuth 2.0 bearer token for Google Calendar", "Request-reply, synchronous, with a timeout (5 seconds per call; 10–20 seconds for bulk traffic data and route recalculation) and a defined failure path."),
    row("C9", "Browser ↔ Supabase Auth and Google", "OAuth 2.0 redirect over HTTPS", "Request-reply, at sign-in only. Returns a login token, which the browser then sends on C1."),
])

NFRTAB = table(["Quality attribute", "Requirement", "How the architecture delivers it"], [
    row("Security", "NFR-5.1, NFR-5.2, NFR-5.4", "Most data access is enforced by the database: requests run with the user's token, so RLS and the checks inside SQL functions apply, and a missing check in one endpoint does not by itself expose other users' rows. Secret-key access is limited to the five uses listed in Section 5.2, and the browser never connects to the database for data."),
    row("Reliability", "NFR-3.1, NFR-3.2", "Persistent state is held in a managed PostgreSQL instance rather than in the application process, so it survives restarts and redeployments. A Google Calendar failure is contained in one adapter and does not stop scheduling or monitoring."),
    row("Robustness", "NFR-2.1", "Each external call times out (5 seconds per call; 10–20 seconds for bulk traffic data and route recalculation) and surfaces as the <i>Service Unavailable</i> state in the Dialog Map, so the coordinator is shown a recoverable failure instead of stale or missing data."),
    row("Efficiency", "NFR-2.1, NFR-6.2", "Open screens poll on fixed intervals (C6): 5 seconds for trip progress, 15 seconds for notifications and availability, 30 seconds for the trip list and account. Background traffic checks only claim assigned trips that are in progress or whose pickup is between one day ago and one hour from now, so the load grows with active trips rather than with all records."),
    row("Maintainability", "NFR-7.1", "One adapter per external service, and each business operation in its own SQL function, so an external API change or a rule change is contained in one place."),
    row("Privacy", "NFR-6.1, NFR-6.2, NFR-6.3", "Each response is filtered by the viewer's role and link, by RLS in the database, before it reaches the browser. Only the latest position of an active trip is stored, and it is cleared when the trip ends."),
])

PATTERNS = table(["Pattern", "Where it is used", "Why"], [
    row("Layered architecture", "Presentation, API, Service and Data Layers", "Separation of concerns; each layer can be replaced without disturbing the others."),
    row("Client-server", "Browser single-page application, NestJS server and database", "Business rules and security are centralised on the server side, never in the browser."),
    row("Adapter", "OneMap, LTA DataMall and Google Calendar adapters", "An external API change affects one adapter only (NFR-7.1)."),
    row("Database-enforced rules", "RLS policies and SQL functions in PostgreSQL", "Access and business rules are written once, next to the data, and apply to every request made with a user's token rather than being repeated in each endpoint."),
])


def build():
    return f"""<!DOCTYPE html><html><head><meta charset="utf-8"><title>System Architecture</title><style>{CSS}</style></head><body>

<h1>System Architecture</h1>
<div class="sub">SC2006 Team 4 · Dialysis Transport Coordination System · Final Version</div>
<p>This document describes the high-level structure of the system: its components, the connectors through which
they communicate, the architectural style that governs them, and the key design decisions on persistent data,
access control, external integration and design patterns.</p>

<hr>

<div class="sec">
<h2>1. Architecture Diagram</h2>
<div class="fig">{figure1()}</div>
<div class="cap">Figure 1. Layered client-server architecture. Connector labels C1–C9 are defined in Section 4. The Presentation Layer lists the main screens of each role; confirmation steps, the Schedule Form and exception states are shown in the Dialog Map.</div>
</div>

<h2>2. Architectural Style</h2>
<p>The system uses a <b>layered architecture</b> combined with a <b>client-server</b> style. The client is a React
single-page application in the user's browser; the server is a NestJS application backed by a PostgreSQL database
that enforces most business and access rules itself. Open screens stay current by <b>polling</b> the API
(connector C6), and background work is started by a timer inside the server (C5).</p>

<h3>2.1 The style, stated as a style</h3>
<p>An architectural style is a vocabulary of component and connector types, a topology and a set of constraints.
For this system these are:</p>
<ul>
<li><b>Component types:</b> boundary components (screens and REST controllers),
control components (one service per area of the use case model, each starting with token and input validation; two of them
also run on timers), entity components (the database tables, with the
SQL functions and RLS policies that guard them) and adapter components (one per external service).</li>
<li><b>Connector types:</b> HTTPS request-reply (including periodic polling), local call-and-return, an
in-process timer, supabase-js calls over HTTPS and an OAuth 2.0 sign-in redirect. These are set out in full in
Section 4.</li>
<li><b>Topology:</b> four layers in a strict stack, with the Data Layer and the Integration Layer side by side
beneath the Service Layer, as drawn in Figure 1.</li>
<li><b>Semantic constraints:</b> a layer may only call the layer directly below it; the browser never queries the
database; every request except the sign-in redirect (C9) passes through the API Layer; the API Layer holds no business logic; services within the
Service Layer may call each other; access rules for user data are enforced in the Data Layer; and no lower layer
ever calls a layer above it, because the browser learns of changes by polling.</li>
</ul>

<h3>2.2 Design principles behind the style</h3>
<ul>
<li><b>Separation of concerns.</b> Presentation, task coordination, data with its rules, and external integration
each sit in their own layer, so a change to one does not reach into the others.</li>
<li><b>Low coupling.</b> Layers depend on the interface of the layer below, not its implementation. Screens can
change without touching scheduling rules, and apart from a few direct reads, services depend on named SQL functions
rather than table layouts, so a table can change without touching the services as long as the function keeps its
signature.</li>
<li><b>High cohesion.</b> Each service groups the logic for one area of the use case model, so the reason to change
a service is a change to that area.</li>
<li><b>Modularity and abstraction.</b> SQL functions and adapters hide storage and external APIs behind interfaces
owned by the application.</li>
<li><b>Single responsibility.</b> The API Layer receives and routes requests; the Service Layer authenticates and
validates, then coordinates the steps of a task and calls external services; the Data Layer stores data and enforces
its rules.</li>
<li><b>Traceability.</b> The layers match the boundary / control / entity stereotypes, so every class in the design
class diagram belongs to exactly one layer. Section 3 maps each control class to the code module that implements it.</li>
</ul>

<h2 class="pb">3. Components</h2>
<p>Service-layer components keep the control-class names of the design class diagram. In the code they are grouped
into fewer NestJS modules, so the mapping is many-to-one: the 13 control classes are implemented in five business
modules (<code>auth</code>, <code>profiles</code>, <code>scheduling</code>, <code>drivers</code>, <code>trips</code>)
plus <code>integrations</code>, and most operational controls live in <code>trips</code>. A separate
<code>demo</code> module supports demonstrations only and is not part of the design model.</p>
<p>Every service starts the same way: it verifies the login token with Supabase Auth, rejects inactive accounts and
roles that can never use the endpoint, and validates the request fields. Controllers pass the header and body
through unchanged. Ownership and the detailed role rules are then enforced by the database (Section 5.2).</p>
{COMPONENTS}

<h2 class="pb">4. Connectors</h2>
<p>Shaw and Garlan define a software architecture as its components together with its <b>connectors</b> — the
interactions among those components. The connectors below are labelled C1–C9 in Figure 1.</p>
{CONNECTORS}
<div class="note"><b>Why polling rather than push.</b> Open screens fetch fresh data on a fixed interval (C6) instead
of holding a push connection. This needs no separate WebSocket server, keeps every exchange a normal authorised
request through the API Layer, and keeps the dependency direction downward: no lower layer ever calls the browser.
<b>Why C7 is dashed.</b> It is the only connector that bypasses Row-Level Security, so its uses are kept to the five
listed in Section 5.2.</div>

<h2>5. Key Design Decisions</h2>

<h3>5.1 Identifying and storing persistent data</h3>
<ul>
<li><b>Persistent objects:</b> all 18 entity classes of the design class diagram — Transport Coordinator, Patient,
Caregiver, CaregiverPatientLink, Driver, Vehicle, AvailabilityWindow, TreatmentSlot, DialysisCentre, Trip, TripLog,
RouteAssessment, TrafficDisruption, RecoveryAction, Notification, DriverRating, DriverPreference and
CalendarReminder.</li>
<li><b>Relational database:</b> PostgreSQL, because the data is highly connected (a trip links a patient, driver,
vehicle, treatment slot and centre) and some changes must succeed together, e.g. cancelling a trip and releasing
its driver.</li>
<li><b>Managed service:</b> Supabase hosts the database, so data survives application restarts and redeployments
(NFR-3.1).</li>
<li><b>Rules in SQL functions:</b> business operations such as assigning a driver or cancelling a trip are SQL
functions in the database, called through supabase-js <code>rpc()</code>. Services do not write SQL; a few simple
reads use supabase-js table queries.</li>
<li><b>Entities mapped to tables:</b> most entities of the design class diagram have their own PostgreSQL table;
some are part of another table, e.g. a Transport Coordinator is an account with the coordinator role. Rules about
an entity are table constraints or checks inside the functions that change it, so they hold for every caller.</li>
<li><b>Atomic operations:</b> each SQL function runs as one transaction, so a use case that writes several records
either fully succeeds or changes nothing. For example, cancelling a trip and releasing its driver and vehicle are
committed together (UC-11.1).</li>
<li><b>Live location:</b> a driver's position is sent to the server as it is recorded, and viewers fetch it by
polling. Only the latest position of an active trip is stored, and it is cleared when the trip ends (NFR-6.2).</li>
</ul>

<h3>5.2 Providing access control</h3>
<ul>
<li><b>Authentication:</b> users sign in with their Google account (OAuth 2.0) through Supabase Auth, which verifies
the Google identity and issues a login token. There is no password form. This redirect (C9) is the only exchange
that does not pass through the API Layer, and it returns only a token. Every later request must carry a valid token,
which the server checks before doing anything else (NFR-5.1).</li>
<li><b>Role-based access control:</b> each account has exactly one role. Each service first rejects inactive
accounts and roles that can never use the endpoint. The detailed role rules of the access matrix below are written
in the database, as RLS policies and checks inside SQL functions (NFR-5.2, FR-1.3).</li>
<li><b>Ownership checks:</b> beyond the role, users only reach their own data. Patients see their own trips;
Caregivers only Patients they are linked to (NFR-5.4); Drivers only trips assigned to them, with only the patient
information needed for the trip (NFR-6.1). These checks are also enforced in the database.</li>
<li><b>Enforced in the database:</b> the backend reads and writes user data with the user's own token (C3), so
PostgreSQL knows who is asking and applies RLS and the functions' checks. A missing check in one endpoint therefore
does not by itself expose other users' rows. The backend's secret key bypasses RLS and is used for five purposes
only (C7): the shared route cache; generating and storing recovery options; the background traffic monitor; Google
Calendar connections and reminder sync, whose OAuth tokens are stored encrypted and never reach the browser; and demo
mode. The browser never connects to the database for data.</li>
</ul>
<div class="sec">{table(["Object / operation", "Transport Coordinator", "Driver", "Patient", "Caregiver"], [
    row("Patient records", "view; update status and notes", "—", "edit own (My Account)", "—"),
    row("Caregiver-Patient links", "view; unlink; re-activate with the Patient's authorisation", "—", "confirm a Caregiver's invitation; view; unlink", "create an invitation; view; unlink"),
    row("Treatment schedules", "view; review change requests", "—", "create, edit, delete own", "create, edit, delete linked Patients'"),
    row("Trips", "generate, assign, delete unassigned", "—", "—", "—"),
    row("Trip details", "view all", "view assigned", "view own", "view linked Patients'"),
    row("Confirm / cancel upcoming trip", "—", "—", "own", "linked Patients'"),
    row("Availability", "view", "update own; report unavailability", "—", "—"),
    row("Recovery options", "generate, approve", "—", "—", "—"),
    row("Driver live location", "view active trips", "send (own active trip)", "view own active trip", "view linked Patients' active trip"),
    row("Driver rating, preferred driver", "—", "—", "own", "—"),
    row("Calendar reminders", "—", "—", "own", "linked Patients'"),
    row("Audit log", "view", "—", "—", "—"),
])}</div>

<div class="sec">
<h3>5.3 Integrating external services</h3>
<ul>
<li>Each external service has its own adapter behind an interface owned by the application, so an API change
affects one adapter only (NFR-7.1).</li>
<li>Each routing and traffic call times out after 5 seconds; bulk LTA fetches and route recalculation allow 10–20
seconds. A timeout appears as the <i>Service Unavailable</i> state
in the Dialog Map instead of stale data (NFR-2.1, UC-08.EX1).</li>
<li>A Google Calendar failure only affects reminders; scheduling and monitoring continue (NFR-3.2, UC-13.EX1).
Calendar access needs the user's OAuth consent (NFR-5.3, UC-13.EX2), and only the trip fields needed for the
reminder are sent (NFR-6.3).</li>
</ul>
</div>

<div class="sec">
<h3>5.4 Design patterns</h3>
{PATTERNS}
</div>

<h2>6. Meeting the Non-Functional Requirements</h2>
<p>The architecture exists to satisfy the quality attributes, not only the functions. The table below states which
architectural mechanism delivers each one.</p>
{NFRTAB}

<div class="sec">
<h2>7. Constraints</h2>
<ul>
<li><b>Languages:</b> TypeScript on both sides — React with Vite in the browser, NestJS on the server — so the team
works in one language and toolchain. SQL (PL/pgSQL) in the database for business rules and access policies.</li>
<li><b>Libraries and services:</b> Tailwind CSS for styling; supabase-js for database and authentication access;
Supabase for PostgreSQL and authentication; Playwright for browser tests and the Node.js test runner (via
<code>tsx</code>) for backend tests. The ORM and test libraries named in the Lab 3 technology-stack exercise
(Prisma, Jest, Vitest) were not adopted: database access goes through SQL functions and RLS (Sections 5.1, 5.2).</li>
<li><b>Communications:</b> HTTPS for all browser-to-server, server-to-database and server-to-external traffic, with
periodic polling instead of server push; OAuth 2.0 for Google sign-in and Google Calendar. No other protocol is
used.</li>
<li><b>Deployment:</b> frontend and backend on Render; database and authentication on Supabase Cloud. A single
server process, with no microservices and no separate backend in another language — not justified by the current
design at this scale.</li>
<li><b>Team:</b> the team already knows TypeScript, React, NestJS and Supabase, so the architecture deliberately
avoids technologies that would need to be learned before the build starts.</li>
</ul>
</div>

</body></html>"""


if __name__ == "__main__":
    import pathlib
    here = pathlib.Path(__file__).parent
    html_path = here / "system_architecture.html"
    pdf_path = here / "System_Architecture.pdf"
    html_path.write_text(build(), encoding="utf-8")
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page()
        pg.goto(html_path.as_uri())
        pg.pdf(path=str(pdf_path), format="A4", prefer_css_page_size=True, print_background=True)
        b.close()
    print(f"wrote {pdf_path}")
