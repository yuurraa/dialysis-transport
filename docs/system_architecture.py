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
          ["Coordinator Trips · Coordinator Schedules", "Generate Trips · Patients · Patient Details",
           "Match a Driver · Recovery Options", "Route & Traffic Monitor · Audit Log"])
    s.box(px[2], 70, pw, 100, "Driver UI",
          ["Driver Trips & Availability"])
    s.box(px[3], 70, pw, 100, "Patient & Caregiver UI",
          ["Patient Trips · Patient Schedules", "Add Reminder",
           "Rate Driver · Preferred Driver  (Patient only)"])

    # ---------- Presentation <-> API ----------
    s.arrow(430, 182, 430, 256)
    s.txt(440, 214, "HTTPS REST / JSON", 10.5)
    s.tag(440, 231, "C1")
    s.arrow(880, 256, 880, 182, dashed=True)
    s.txt(890, 214, "WebSocket push", 10.5)
    s.tag(890, 231, "C6")

    # ---------- Application server ----------
    s.band(20, 258, 1140, 352, "none", "#8a8f94", None, dashed=True)
    s.txt(1148, 276, "Application Server — NestJS + TypeScript (Render)", 10.5, "end", color="#667", italic=True)

    s.band(35, 284, 1110, 88, API_F, API_S, "API Layer")
    s.boundary_icon(1105, 302)
    s.box(50, 320, 350, 36, "REST Controllers", center=True)
    s.box(415, 320, 350, 36, "Auth & RBAC Guard", center=True)
    s.box(780, 320, 350, 36, "WebSocket Gateway", center=True)

    s.arrow(430, 372, 430, 408)
    s.txt(440, 388, "calls services", 10.5)
    s.tag(508, 388, "C2")
    s.arrow(880, 408, 880, 372, dashed=True)
    s.txt(760, 388, "publishes events", 10.5, "end")
    s.tag(766, 388, "C5")

    s.band(35, 410, 1110, 186, SVC_F, SVC_S, "Service Layer")
    s.control_icon(1110, 428)
    sb = [
        (50, 440, "Access", ["AuthenticationControl", "ProfileManagerControl"]),
        (415, 440, "Scheduling", ["ScheduleControl · AvailabilityControl", "TripControl"]),
        (780, 440, "Operations & Recovery", ["MonitoringControl · TrackingControl", "RiskRecoveryControl · RouteAssessmentControl"]),
        (50, 516, "Patient Services", ["FeedbackAndPreferenceControl", "CalendarSyncControl"]),
        (415, 516, "Notification", ["NotificationControl"]),
        (780, 516, "Audit", ["TripHistoryControl"]),
    ]
    for x, y, t, l in sb:
        s.box(x, y, 350, 66, t, l)

    # ---------- down to Data / Integration ----------
    s.arrow(330, 610, 330, 650)
    s.txt(340, 628, "read / write", 10.5)
    s.tag(404, 628, "C3")
    s.arrow(830, 610, 830, 650)
    s.txt(840, 628, "external requests", 10.5)
    s.tag(936, 628, "C4")

    # ---------- Data layer ----------
    s.band(20, 652, 660, 248, DATA_F, DATA_S, "Data Layer")
    s.entity_icon(652, 672)
    s.box(35, 684, 300, 92, "Entities", ["Transport Coordinator · Patient · Caregiver",
                                          "Driver · Vehicle · Trip · TreatmentSlot · TripLog",
                                          "TrafficDisruption · … — 18 in all (class diagram)"])
    s.box(348, 684, 297, 92, "Repositories (DAO)", ["Prisma ORM", "One repository per entity;", "the only code that touches the database"])
    s.arrow(497, 776, 497, 790)
    s.tag(505, 785, "C7")
    s.cyl(497, 792, 150, 64, "Supabase", "PostgreSQL")

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
    s.txt(957, 684, "HTTPS", 9, "middle", color="#667")
    s.tag(955, 775, "C8")
    # sign-in: the browser is redirected to Supabase Auth and Google, outside the API Layer
    s.box(978, 846, 185, 46, "Supabase Auth", ["Google identity provider"], dashed=True, fill=EXT_F, stroke=EXT_S)
    s.o.append(f'<polyline points="1160,120 1172,120 1172,869 1165,869" fill="none" stroke="{ARROW}" '
               f'stroke-width="1.4" marker-start="url(#a)" marker-end="url(#a)"/>')
    s.txt(1166, 626, "OAuth 2.0 sign-in", 10.5, "end")
    s.tag(1138, 643, "C9")

    # ---------- Legend ----------
    s.band(20, 918, 1140, 80, LEG_F, LEG_S, None)
    s.o.append(f'<line x1="40" y1="944" x2="98" y2="944" stroke="{ARROW}" stroke-width="1.4" marker-end="url(#a)"/>')
    s.txt(106, 948, "Call to the layer directly below (synchronous)", 10.5)
    s.o.append(f'<line x1="400" y1="944" x2="458" y2="944" stroke="{ARROW}" stroke-width="1.4" stroke-dasharray="6 4" marker-end="url(#a)"/>')
    s.txt(466, 948, "Event notification / server push (not a call)", 10.5)
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
    row("API Layer (server)", "boundary", "Receives requests, checks the login token, role and ownership, then hands over to a service. Contains no business logic. The <code>Application</code> class of the design class diagram is the server entry point that starts this layer."),
    row("Service Layer (server)", "control", "All business logic. Each service is a control class from the design class diagram and coordinates the entities involved in one task."),
    row("Data Layer", "entity, repository","Entity classes and the repositories that load and save them in the database."),
    row("Integration Layer", "adapter", "One adapter per external service, used by the Service Layer alongside the Data Layer."),
])

COMPONENTS = table(["Component", "Responsibility", "Traces to"], [
    row("Shared Entry UI", "Login; two-step signup (Create Account, Complete Details); Account Inactive; Select Patient for Caregivers linked to more than one Patient; My Account.", "UC-01; Dialog Map — Shared Entry"),
    row("Coordinator UI", "Coordinator Trips, Coordinator Schedules and Generate Trips, Patients and Patient Details, driver matching, recovery options, route &amp; traffic monitor, audit log.", "UC-02 to UC-05, UC-08; Dialog Map — Coordinator"),
    row("Driver UI", "Driver Trips and availability, Confirm Unavailability. While a trip is active, Driver Trips sends the driver's live location in the background, so the Dialog Map needs no separate state for it.", "UC-06, UC-07, UC-09, UC-10; Dialog Map — Driver"),
    row("Patient &amp; Caregiver UI", "Patient Trips, which shows live tracking within the page rather than on a separate screen; Patient Schedules, confirm / cancel trip, rate and preferred driver (Patient only), add reminder.", "UC-03, UC-09, UC-10, UC-11, UC-11.1, UC-12, UC-13; Dialog Map — Patient &amp; Caregiver"),
    row("REST Controllers", "One endpoint per user action, e.g. <code>POST /trips/:id/cancel</code>.", "All use cases"),
    row("Auth &amp; RBAC Guard", "Checks the login token, the user's role and, where needed, the Caregiver-Patient link before any service is called.", "UC-01; NFR-5.1, NFR-5.2, NFR-5.4"),
    row("WebSocket Gateway", "Pushes live location, trip status and notifications to users allowed to see them.", "UC-09, UC-10; NFR-6.2"),
    row("Access", "<code>AuthenticationControl</code>, <code>ProfileManagerControl</code>: login, profile records, Caregiver-Patient links.", "UC-01, UC-02, UC-02.1"),
    row("Scheduling", "<code>ScheduleControl</code>, <code>AvailabilityControl</code>, <code>TripControl</code>: recurring trips, driver and vehicle assignment, availability, confirmation and cancellation.", "UC-03, UC-03.1, UC-06, UC-07, UC-11, UC-11.1"),
    row("Operations &amp; Recovery", "<code>MonitoringControl</code>, <code>TrackingControl</code>, <code>RiskRecoveryControl</code>, <code>RouteAssessmentControl</code>: trip status, live tracking, recovery options, route and ETA.", "UC-04, UC-05, UC-05.1, UC-08, UC-09"),
    row("Patient Services", "<code>FeedbackAndPreferenceControl</code>, <code>CalendarSyncControl</code>: ratings, preferred driver, calendar reminders.", "UC-12, UC-13"),
    row("Notification", "<code>NotificationControl</code>: finds the affected users and publishes notifications.", "UC-10"),
    row("Audit", "<code>TripHistoryControl</code>: records assignments, disruptions, recoveries, cancellations and final status; serves the Audit Log.", "UC-04.AF2; FR-6.4"),
    row("Entities", "The 18 entity classes of the design class diagram, written by the team rather than generated. Each entity carries the methods from the class diagram and enforces rules about itself, e.g. a Trip can only be cancelled while upcoming.", "Design class diagram"),
    row("Repositories (DAO)", "Load and save entities through Prisma ORM, converting between database records and entity classes; the only code that touches the database.", "NFR-3.1"),
    row("Supabase PostgreSQL", "Relational database for all persistent data, reached only through the repositories.", "NFR-3.1"),
    row("Supabase Auth", "External identity service. The browser is redirected to it, and through it to Google, to sign in (C9); it verifies the Google identity and issues login tokens.", "UC-01; NFR-5.1"),
    row("Integration adapters", "OneMap, LTA DataMall and Google Calendar adapters; HTTPS with a 5-second timeout, OAuth 2.0 for Google Calendar.", "UC-08, UC-13; NFR-2.1, NFR-7.1"),
])

CONNECTORS = table(["#", "Between", "Mechanism", "Direction and timing"], [
    row("C1", "Browser → API Layer", "HTTPS request carrying JSON, with the login token in the authorisation header", "Request-reply, synchronous. Every user action is one request."),
    row("C2", "API Layer → Service Layer", "Local method call inside the NestJS process", "Call-and-return, synchronous."),
    row("C3", "Service Layer → Data Layer", "Local method call on a repository interface", "Call-and-return, synchronous. Wrapped in a transaction where a use case writes several records."),
    row("C4", "Service Layer → Integration Layer", "Local method call on an adapter interface", "Call-and-return, synchronous, with a 5-second timeout."),
    row("C5", "Service Layer → WebSocket Gateway", "In-process event publish-subscribe (implicit invocation)", "One-way, asynchronous. The publisher does not know the subscribers and does not wait."),
    row("C6", "WebSocket Gateway → Browser", "WebSocket server push over a connection opened by the browser", "One-way, asynchronous. Not a reply to a request."),
    row("C7", "Repositories → Supabase PostgreSQL", "SQL over TCP/TLS, generated by Prisma", "Call-and-return, synchronous, across a network boundary."),
    row("C8", "Integration adapters → External APIs", "HTTPS over the public internet; OAuth 2.0 bearer token for Google Calendar", "Request-reply, synchronous, with a 5-second timeout and a defined failure path."),
    row("C9", "Browser ↔ Supabase Auth and Google", "OAuth 2.0 redirect over HTTPS", "Request-reply, at sign-in only. Returns a login token, which the browser then sends on C1."),
])

NFRTAB = table(["Quality attribute", "Requirement", "How the architecture delivers it"], [
    row("Security", "NFR-5.1, NFR-5.2, NFR-5.4", "All checks run on the server. The Auth &amp; RBAC Guard sits in front of every service call, and the browser never connects to the database, so there is a single place to enforce authentication, role and ownership."),
    row("Reliability", "NFR-3.1, NFR-3.2", "Persistent state is held in a managed PostgreSQL instance rather than in the application process, so it survives restarts and redeployments. A Google Calendar failure is contained in one adapter and does not stop scheduling or monitoring."),
    row("Robustness", "NFR-2.1", "External calls time out after 5 seconds and surface as the <i>Service Unavailable</i> state in the Dialog Map, so the coordinator is shown a recoverable failure instead of stale or missing data."),
    row("Efficiency", "NFR-2.1, NFR-6.2", "Live location and trip status are pushed over C5 and C6 rather than polled, so the browser does not repeatedly ask for data that has not changed."),
    row("Maintainability", "NFR-7.1", "One adapter per external service, and one repository per entity, so an external API change or a database change is contained in a single layer."),
    row("Privacy", "NFR-6.1, NFR-6.2, NFR-6.3", "Each push and each response is filtered by the viewer's role and link before it leaves the server. Only the latest position of an active trip is stored, and it is cleared when the trip ends."),
])

PATTERNS = table(["Pattern", "Where it is used", "Why"], [
    row("Layered architecture", "Presentation, API, Service and Data Layers", "Separation of concerns; each layer can be replaced without disturbing the others."),
    row("Client-server", "Browser single-page application and NestJS server", "Business rules and security are centralised on the server."),
    row("Adapter", "OneMap, LTA DataMall and Google Calendar adapters", "An external API change affects one adapter only (NFR-7.1)."),
    row("Data Access Object", "Prisma repositories in the Data Layer", "Storage details are hidden behind an interface, so services never write SQL."),
    row("Observer (publish-subscribe)", "<code>NotificationControl</code> publishes events; the WebSocket Gateway subscribes and pushes them to the browsers of the affected users", "Senders do not need to know who is listening. This is the implicit-invocation form of an event system."),
    row("Strategy", "The rules that rank candidate assignments in <code>ScheduleControl</code> and candidate recovery actions in <code>RiskRecoveryControl</code> are separate interchangeable objects behind one interface", "UC-03.1 applies mandatory constraints, then patient preferred driver, then driver continuity; UC-05 ranks recovery options. Keeping each rule as its own strategy means a new or reordered rule is added without editing the service — the Open-Closed Principle."),
])


def build():
    return f"""<!DOCTYPE html><html><head><meta charset="utf-8"><title>System Architecture</title><style>{CSS}</style></head><body>

<h1>System Architecture</h1>
<div class="sub">SC2006 Team 4 · Dialysis Transport Coordination System · Lab 3 Deliverable</div>
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
single-page application in the user's browser; the server is a NestJS application. Upward communication uses an
<b>event system</b> with implicit invocation, described as connector C5 below.</p>

<h3>2.1 The style, stated as a style</h3>
<p>An architectural style is a vocabulary of component and connector types, a topology and a set of constraints.
For this system these are:</p>
<ul>
<li><b>Component types:</b> boundary components (screens, REST controllers, the guard and the gateway),
control components (one service per area of the use case model), entity components (the domain classes and their
repositories) and adapter components (one per external service).</li>
<li><b>Connector types:</b> HTTPS request-reply, local call-and-return, in-process publish-subscribe,
WebSocket server push, SQL over TCP and an OAuth 2.0 sign-in redirect. These are set out in full in Section 4.</li>
<li><b>Topology:</b> four layers in a strict stack, with the Data Layer and the Integration Layer side by side
beneath the Service Layer, as drawn in Figure 1.</li>
<li><b>Semantic constraints:</b> a layer may only call the layer directly below it; the browser never queries the
database; every request except the sign-in redirect (C9) passes through the API Layer; the API Layer holds no business logic; services within the
Service Layer may call each other; and the only upward communication is event notification, never a call, so no
lower layer ever depends on a layer above it.</li>
</ul>

<h3>2.2 Design principles behind the style</h3>
<ul>
<li><b>Separation of concerns.</b> Presentation, business rules, persistence and external integration each sit in
their own layer, so a change to one does not reach into the others.</li>
<li><b>Low coupling.</b> Layers depend on the interface of the layer below, not its implementation. Screens can
change without touching scheduling rules, and the database can change without touching the services.</li>
<li><b>High cohesion.</b> Each service groups the logic for one area of the use case model, so the reason to change
a service is a change to that area.</li>
<li><b>Modularity and abstraction.</b> Repositories and adapters hide storage and external APIs behind interfaces
owned by the application.</li>
<li><b>Single responsibility.</b> The API Layer authenticates and routes; the Service Layer decides; the Data Layer
stores. No component does two of these.</li>
<li><b>Open-closed.</b> Assignment and recovery ranking rules are separate strategy objects (Section 5.4), so a new
rule is added rather than an existing service edited.</li>
<li><b>Traceability.</b> The layers match the boundary / control / entity stereotypes, so every class in the design
class diagram belongs to exactly one layer and the same names are used in the code.</li>
</ul>

<h2 class="pb">3. Components</h2>
{COMPONENTS}

<h2 class="pb">4. Connectors</h2>
<p>Shaw and Garlan define a software architecture as its components together with its <b>connectors</b> — the
interactions among those components. The connectors below are labelled C1–C9 in Figure 1.</p>
{CONNECTORS}
<div class="note"><b>Why C5 and C6 are not calls.</b> If a service called the browser, a lower layer would depend on a
higher one and the layering constraint in Section 2.1 would be broken. Instead the service publishes an event and does
not know or care who receives it; the gateway subscribes and pushes. This keeps the dependency direction downward
everywhere in the system, which is why these two connectors are drawn as dashed arrows.</div>

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
<li><b>Access through repositories only:</b> services never write SQL. They call repositories, so a database change
is contained in the Data Layer.</li>
<li><b>Entity classes separate from database records:</b> Prisma generates plain data types with fields only.
Repositories convert these records into the team's own entity classes, which carry behaviour such as
<code>Trip.updateStatus()</code> or <code>AvailabilityWindow.overlaps()</code>, and convert them back when saving.</li>
<li><b>Transactions controlled by the Service Layer:</b> when one use case writes several records, the service wraps
all writes in a single database transaction (Prisma <code>$transaction</code>), so they either all succeed or none
are applied. For example, cancelling a trip and releasing its driver and vehicle are committed together
(UC-11.1).</li>
<li><b>Live location:</b> a driver's position is pushed to viewers as it arrives. Only the latest position of an
active trip is stored, and it is cleared when the trip ends (NFR-6.2).</li>
</ul>

<h3>5.2 Providing access control</h3>
<ul>
<li><b>Authentication:</b> users sign in with their Google account (OAuth 2.0) through Supabase Auth, which verifies
the Google identity and issues a login token. There is no password form. This redirect (C9) is the only exchange
that does not pass through the API Layer, and it returns only a token. Every later request must carry a valid token,
which the API Layer checks (NFR-5.1).</li>
<li><b>Role-based access control:</b> each account has exactly one role. The guard checks the role on every
endpoint against the access matrix below (NFR-5.2, FR-1.3).</li>
<li><b>Ownership checks:</b> beyond the role, users only reach their own data. Patients see their own trips;
Caregivers only Patients they are linked to (NFR-5.4); Drivers only trips assigned to them, with only the patient
information needed for the trip (NFR-6.1).</li>
<li><b>Checked on the server:</b> the server connects to the database with a privileged account, so the database
itself cannot tell users apart. All checks are therefore done in the API and Service Layers, and the browser never
connects to the database.</li>
</ul>
{table(["Object / operation", "Transport Coordinator", "Driver", "Patient", "Caregiver"], [
    row("Patient records", "view; update status and notes", "—", "edit own (My Account)", "—"),
    row("Caregiver-Patient links", "link", "—", "—", "—"),
    row("Treatment schedules", "view", "—", "create, edit, delete own", "—"),
    row("Trips", "generate, assign, delete unassigned", "—", "—", "—"),
    row("Trip details", "view all", "view assigned", "view own", "view linked Patients'"),
    row("Confirm / cancel upcoming trip", "—", "—", "own", "linked Patients'"),
    row("Availability", "view", "update own; report unavailability", "—", "—"),
    row("Recovery options", "generate, approve", "—", "—", "—"),
    row("Driver live location", "view active trips", "send (own active trip)", "view own active trip", "view linked Patients' active trip"),
    row("Driver rating, preferred driver", "—", "—", "own", "—"),
    row("Calendar reminders", "—", "—", "own", "linked Patients'"),
    row("Audit log", "view", "—", "—", "—"),
])}

<div class="sec">
<h3>5.3 Integrating external services</h3>
<ul>
<li>Each external service has its own adapter behind an interface owned by the application, so an API change
affects one adapter only (NFR-7.1).</li>
<li>Routing and traffic calls time out after 5 seconds; the timeout appears as the <i>Service Unavailable</i> state
in the Dialog Map instead of stale data (NFR-2.1, UC-08.EX1).</li>
<li>A Google Calendar failure only affects reminders; scheduling and monitoring continue (NFR-3.2, UC-13.EX1).
Calendar access needs the user's OAuth consent (NFR-5.3, UC-13.EX2), and only the trip fields needed for the
reminder are sent (NFR-6.3).</li>
</ul>
</div>

<h3>5.4 Design patterns</h3>
{PATTERNS}

<h2 class="pb">6. Meeting the Non-Functional Requirements</h2>
<p>The architecture exists to satisfy the quality attributes, not only the functions. The table below states which
architectural mechanism delivers each one.</p>
{NFRTAB}

<h2>7. Constraints</h2>
<ul>
<li><b>Languages:</b> TypeScript on both sides — React with Vite in the browser, NestJS on the server. One language
across the stack keeps the entity definitions and their validation rules shared rather than duplicated.</li>
<li><b>Libraries and services:</b> Tailwind CSS for styling, Prisma as the ORM, Supabase for PostgreSQL and
authentication, Jest, Vitest and React Testing Library for tests. These were confirmed in the Lab 3 technology-stack
exercise and are unchanged from Lab 2.</li>
<li><b>Communications:</b> HTTPS for all browser-to-server and server-to-external traffic; WebSocket for server push;
OAuth 2.0 for Google sign-in and Google Calendar. No other protocol is used.</li>
<li><b>Deployment:</b> frontend and backend on Render; database and authentication on Supabase Cloud. A single
server process, with no microservices and no separate backend in another language — not justified by the current
design at this scale.</li>
<li><b>Team:</b> the team already knows TypeScript, React, NestJS and Supabase, so the architecture deliberately
avoids technologies that would need to be learned before the build starts.</li>
</ul>

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
