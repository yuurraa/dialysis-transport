"""
Dialog Map generator — SC2006 Team 4, Dialysis Transport Coordination System.

Produces Dynamic_Model_Dialog_Map.pdf from this file alone. Every state,
transition, guard and design note lives here as data, so editing the model
means editing this script rather than redrawing a diagram by hand.

    python3 dialog_map.py              # writes dialog_map.html + the PDF

Layout notes
------------
Coordinates are plain SVG user units; each diagram declares its own viewBox
and the page CSS scales it to the text column. `pair()` draws a matched
forward/return transition pair between two states and places both labels,
routing them around an orthogonal "bus" x-coordinate so arrows do not cross
state boxes. Raising a bus value moves that pair's elbow further from the
source box.

Requires: playwright (chromium). Fonts: Arial / Liberation Sans.
"""

import html as H

# ---------------------------------------------------------------- palette ---
FILL, STROKE = "#ede6d9", "#8f7d65"          # normal UI state
EXF, EXS = "#f4dfda", "#b27f73"              # exception / failure state
LBF, LBT = "#dce6f1", "#33455c"              # normal transition label
LPF, LPT = "#f3ddd8", "#8a4f45"              # exception transition label
ARROW, EXARROW = "#8f7d65", "#a8766b"
TXT = "#333"

CW = 5.35  # approximate character width at 11px, used to size label boxes


def tw(s, size=11):
    return len(s) * CW * size / 11


class SVG:
    """Minimal SVG builder. `els` draws first, `top` draws over it."""

    def __init__(self, w, h):
        self.w, self.h, self.els, self.top = w, h, [], []

    # -- states ------------------------------------------------------------
    def box(self, x, y, w, h, title, lines=(), uc=None, exc=False, sub=None, dashed=False):
        f, s = (EXF, EXS) if exc else (FILL, STROKE)
        if dashed:
            f = "#fff"
        da = ' stroke-dasharray="5 4"' if dashed else ""
        self.els.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="5" fill="{f}" stroke="{s}" stroke-width="1.4"{da}/>')
        if lines or uc:
            self.els.append(f'<text x="{x+w/2}" y="{y+20}" text-anchor="middle" font-size="14" fill="{TXT}">{H.escape(title)}</text>')
            self.els.append(f'<line x1="{x}" y1="{y+30}" x2="{x+w}" y2="{y+30}" stroke="{s}" stroke-width="1.2"/>')
            yy = y + 47
            for ln in lines:
                self.els.append(f'<text x="{x+10}" y="{yy}" font-size="11" fill="{TXT}">{H.escape(ln)}</text>')
                yy += 15
            if uc:
                yy += 6
                for u in uc:
                    self.els.append(f'<text x="{x+10}" y="{yy}" font-size="10" font-style="italic" fill="#777">{H.escape(u)}</text>')
                    yy += 13
        elif sub:
            self.els.append(f'<text x="{x+w/2}" y="{y+h/2-2}" text-anchor="middle" font-size="13" fill="{TXT}">{H.escape(title)}</text>')
            self.els.append(f'<text x="{x+w/2}" y="{y+h/2+13}" text-anchor="middle" font-size="10" font-style="italic" fill="#777">{H.escape(sub)}</text>')
        else:
            parts = title.split("\n")
            y0 = y + h / 2 + 4.5 - (len(parts) - 1) * 7.5
            for i, p in enumerate(parts):
                self.els.append(f'<text x="{x+w/2}" y="{y0+i*15}" text-anchor="middle" font-size="13" fill="{TXT}">{H.escape(p)}</text>')

    def region(self, x, y, w, h, title):
        """Dashed grouping box for a role map. A drawing convention, not a state."""
        self.els.insert(0, f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="8" fill="#fcfbf8" stroke="#bdb5a6" stroke-width="1.2" stroke-dasharray="7 5"/>')
        self.els.insert(1, f'<text x="{x+14}" y="{y+20}" font-size="12.5" font-weight="bold" fill="#8a7c63">{H.escape(title)}</text>')

    def dot(self, x, y):
        self.els.append(f'<circle cx="{x}" cy="{y}" r="7" fill="{ARROW}"/>')

    # -- transitions -------------------------------------------------------
    def poly(self, pts, exc=False, dashed=False, head=True):
        c = EXARROW if exc else ARROW
        d = " ".join(f"{x},{y}" for x, y in pts)
        da = ' stroke-dasharray="5 4"' if dashed else ""
        m = f' marker-end="url(#{"ah2" if exc else "ah"})"' if head else ""
        self.els.append(f'<polyline points="{d}" fill="none" stroke="{c}" stroke-width="1.4"{da}{m}/>')

    def path(self, d, exc=False, dashed=False):
        c = EXARROW if exc else ARROW
        da = ' stroke-dasharray="5 4"' if dashed else ""
        self.els.append(f'<path d="{d}" fill="none" stroke="{c}" stroke-width="1.4"{da} marker-end="url(#{"ah2" if exc else "ah"})"/>')

    # -- text --------------------------------------------------------------
    def label(self, x, y, text, anchor="start", exc=False, size=11):
        """Tinted transition label. x,y is the top-left (or top-right / top-centre)."""
        parts = text.split("\n")
        w = max(tw(p, size) for p in parts) + 12
        h = 15 * len(parts) + 1
        bx = x if anchor == "start" else (x - w if anchor == "end" else x - w / 2)
        f, t = (LPF, LPT) if exc else (LBF, LBT)
        self.top.append(f'<rect x="{bx:.1f}" y="{y}" width="{w:.1f}" height="{h}" rx="2" fill="{f}"/>')
        for i, p in enumerate(parts):
            self.top.append(f'<text x="{bx+6:.1f}" y="{y+11.5+i*15}" font-size="{size}" fill="{t}">{H.escape(p)}</text>')

    def text(self, x, y, s, size=10, italic=True, anchor="start", color="#777", bold=False):
        st = ' font-style="italic"' if italic else ""
        b = ' font-weight="bold"' if bold else ""
        self.top.append(f'<text x="{x}" y="{y}" font-size="{size}"{st}{b} text-anchor="{anchor}" fill="{color}">{H.escape(s)}</text>')

    def notebox(self, x, y, w, h, title, paras):
        self.top.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="5" fill="#f8f7f3" stroke="#d9d5cb" stroke-width="1.2"/>')
        self.top.append(f'<text x="{x+14}" y="{y+20}" font-size="11.5" font-weight="bold" fill="{TXT}">{H.escape(title)}</text>')
        yy = y + 38
        for p in paras:
            for ln in p:
                self.top.append(f'<text x="{x+14}" y="{yy}" font-size="10.5" fill="#444">{H.escape(ln)}</text>')
                yy += 14
            yy += 5

    def svg(self):
        defs = (f'<defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">'
                f'<path d="M0,0 L10,5 L0,10 z" fill="{ARROW}"/></marker>'
                f'<marker id="ah2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">'
                f'<path d="M0,0 L10,5 L0,10 z" fill="{EXARROW}"/></marker></defs>')
        return (f'<svg viewBox="0 0 {self.w} {self.h}" xmlns="http://www.w3.org/2000/svg" font-family="Arial, Liberation Sans, sans-serif">'
                + defs + "".join(self.els) + "".join(self.top) + "</svg>")


def pair(s, ex, e, b, sx, st, fwd, ret, fwd_exc=False, ret_exc=False, lab_right=None, size=11):
    """Forward + return transition pair: source right edge (ex, e) to target left edge (sx, st).

    `b` is the x of the orthogonal elbow; pass 0 when the two states share a y.
    `lab_right` overrides where the labels are right-aligned (default: just left of the target).
    """
    o = 4  # vertical offset so the two arrows do not overlap
    if abs(e - st) < 1:
        s.poly([(ex, e - o), (sx, st - o)], fwd_exc)
        s.poly([(sx, st + o), (ex, e + o)], ret_exc)
    else:
        up = st < e
        bf = b - o if up else b + o
        br = b + o if up else b - o
        s.poly([(ex, e - o), (bf, e - o), (bf, st - o), (sx, st - o)], fwd_exc)
        s.poly([(sx, st + o), (br, st + o), (br, e + o), (ex, e + o)], ret_exc)
    r = lab_right if lab_right is not None else sx - 10
    if fwd:
        s.label(r, st - o - 5 - 15 * len(fwd.split("\n")), fwd, "end", fwd_exc, size)
    if ret:
        s.label(r, st + o + 3, ret, "end", ret_exc, size)


# =================================================== Diagram 0: whole map ===
def d0():
    """Section 1 — every state in one diagram, with the three role maps grouped."""
    L = 9.5  # smaller label text, since this diagram carries the whole model
    s = SVG(1000, 1450)

    # ---- shared entry band: states that belong to no role map ----
    s.dot(400, 6)
    s.poly([(400, 13), (400, 28)])
    s.box(330, 30, 140, 36, "Login")
    s.path("M470,40 C 518,22 518,64 472,58")
    s.label(480, 0, "continue with Google [sign-in failed] / show inline error", size=L)

    s.box(610, 24, 150, 36, "Create Account")
    pair(s, 470, 42, 0, 610, 42, "[no account record]", "Cancel / clear session", size=L)
    s.box(610, 84, 150, 36, "Complete Details")
    s.poly([(650, 60), (650, 82)])
    s.poly([(720, 82), (720, 62)])
    s.label(656, 62, "Next", size=L)
    s.label(726, 62, "Back", size=L)
    s.poly([(760, 102), (965, 102), (965, 977), (170, 977), (170, 897)])
    s.poly([(760, 110), (980, 110), (980, 1372), (170, 1372), (170, 1142)])
    s.label(995, 140, "Sign Up / save account\n[role = Driver]", "end", size=L)
    s.label(995, 190, "Sign Up / save account and owned\nprofile [role = Patient OR Caregiver]", "end", size=L)

    s.box(330, 110, 140, 36, "Account Inactive", exc=True)
    s.poly([(370, 66), (370, 108)], exc=True)
    s.poly([(390, 108), (390, 68)], exc=True)
    s.label(362, 68, "[account inactive]", "end", exc=True, size=L)
    s.label(362, 88, "sign out / clear session", "end", exc=True, size=L)

    s.box(610, 150, 150, 36, "Select Patient")
    s.poly([(470, 58), (530, 58), (530, 168), (608, 168)])
    s.label(480, 130, "[role = Caregiver AND linked patients > 1]", size=L)
    s.poly([(685, 186), (685, 200), (46, 200)])
    s.label(480, 204, "select linked patient", size=L)

    s.box(60, 14, 150, 36, "My Account")
    s.poly([(58, 32), (20, 32), (20, 1125)], head=False)
    s.poly([(20, 300), (20, 34), (57, 34)])
    for ty in (500, 880, 1125):
        s.poly([(20, ty), (71, ty)])
    s.label(100, 164, '"My Account"', size=L)
    s.label(100, 182, '"Trips" / each role\'s menu pages', size=L)

    # ---- role map groupings ----
    s.region(52, 225, 898, 525, "Coordinator")
    s.region(52, 765, 898, 205, "Driver")
    s.region(52, 985, 898, 380, "Patient & Caregiver")
    SX, SW = 450, 170
    RX, RW = 670, 170

    # --- coordinator ---
    DX, DY, DW, DH = 75, 400, 190, 115
    s.box(DX, DY, DW, DH, "Coordinator Trips",
          ["do / display journeys by status", "search / filter / update list",
           "select tile / update list"], uc=["UC-04 (FR-6.1, FR-6.5)"])
    ex = DX + DW
    st = {"sched": 270, "pat": 324, "care": 378, "drv": 432, "del": 486, "match": 540,
          "det": 594, "route": 648, "audit": 702}
    for k, title in (("sched", "Coordinator Schedules"), ("pat", "Patients"), ("care", "Caregivers"),
                     ("drv", "Drivers"), ("del", "Confirm Trip Deletion"), ("match", "Match a Driver"),
                     ("det", "Coordinator Trip Details"), ("route", "Route & Traffic Monitor"), ("audit", "Audit Log")):
        s.box(SX, st[k] - 18, SW, 36, title)
    # rising pairs: the furthest target takes the innermost elbow; falling pairs likewise
    pair(s, ex, 405, 290, SX, st["sched"], '"Schedules"', '"Trips"', size=L)
    pair(s, ex, 417, 305, SX, st["pat"], '"Patients"', '"Trips"', size=L)
    pair(s, ex, 429, 320, SX, st["care"], '"Caregivers"', '"Trips"', size=L)
    pair(s, ex, 441, 335, SX, st["drv"], '"Drivers"', '"Trips"', size=L)
    pair(s, ex, 453, 410, SX, st["del"], '"Delete Trip" [journey unassigned]', "confirm / delete journey; cancel", size=L)
    pair(s, ex, 465, 395, SX, st["match"], '"Assign driver" [trip unfilled]', "approve / assign driver; dismiss", size=L)
    pair(s, ex, 477, 380, SX, st["det"], '"View trip details"', "close", size=L)
    pair(s, ex, 489, 365, SX, st["route"], '"Routes"', "back", size=L)
    pair(s, ex, 501, 350, SX, st["audit"], '"Audit log"', "back", size=L)

    s.box(RX, st["sched"] - 18, RW, 36, "Generate Trips")
    s.poly([(SX + SW, st["sched"] - 5), (RX, st["sched"] - 5)])
    s.poly([(RX, st["sched"] + 5), (SX + SW, st["sched"] + 5)])
    s.label(RX + RW, 234, '"Generate Trips" [schedule generatable]', "end", size=L)
    s.label(RX + RW, 291, "confirm / create unfilled journeys; cancel", "end", size=L)

    s.box(RX, st["pat"] - 18, RW, 36, "Patient Details")
    s.poly([(SX + SW, st["pat"] - 5), (RX, st["pat"] - 5)])
    s.poly([(RX, st["pat"] + 5), (SX + SW, st["pat"] + 5)])
    s.label(RX + RW + 6, st["pat"] - 16, "select record", size=L)
    s.label(RX + RW, 345, "save / update status and notes; cancel", "end", size=L)

    # recovery is offered on trip details
    s.box(RX, st["det"] - 18, RW, 36, "Recovery Options")
    s.poly([(SX + SW, st["det"] - 5), (RX, st["det"] - 5)])
    s.poly([(RX, st["det"] + 5), (SX + SW, st["det"] + 5)])
    s.label(RX + RW, 557, '"Generate recovery options" [trip at-risk]', "end", size=L)
    s.label(RX + 140, 614, "approve / apply option; dismiss", "end", size=L)

    # escalate critical: only exit is escalate, back to Coordinator Trips
    s.box(RX, st["del"] - 18, RW, 36, "Escalate Critical", exc=True)
    s.poly([(RX + RW, st["det"] - 6), (895, st["det"] - 6), (895, st["del"] + 8), (RX + RW + 2, st["del"] + 8)], exc=True)
    s.label(RX + 4, st["del"] + 21, "[no feasible option]", exc=True, size=L)
    s.poly([(RX + RW, st["del"] - 8), (930, st["del"] - 8), (930, 231), (170, 231), (170, DY - 2)], exc=True)
    s.label(700, 216, "escalate / classify trip Unfilled-Critical", "middle", exc=True, size=L)

    # service unavailable: raised by Recovery Options and Route & Traffic Monitor
    s.box(RX, st["audit"] - 18, RW, 36, "Service Unavailable", exc=True)
    s.poly([(RX + 150, st["det"] + 18), (RX + 150, st["audit"] - 20)], exc=True)
    s.poly([(RX + 160, st["audit"] - 20), (RX + 160, st["det"] + 20)], exc=True)
    s.label(RX + RW + 6, 640, "[service timeout > 5 s]", exc=True, size=L)
    s.poly([(SX + SW, st["route"] + 2), (RX, st["audit"] - 8)], exc=True)
    s.poly([(RX, st["audit"]), (SX + SW, st["route"] + 10)], exc=True)
    s.label(RX + 4, st["audit"] + 22, "retry / back (to originating screen)", exc=True, size=L)

    # --- driver ---
    AX, AY, AW, AH = 75, 790, 190, 105
    s.box(AX, AY, AW, AH, "Driver Trips",
          ["do / display assigned pickups", "do / display notifications", "filter by date / update list"],
          uc=["UC-04, UC-10 (FR-6.2)"])
    dt = {"av": 805, "veh": 861, "det": 917}
    s.box(SX, dt["av"] - 22, SW, 44, "Driver Availability", sub="UC-06 (FR-3.1)")
    s.box(SX, dt["veh"] - 22, SW, 44, "My Vehicle", sub="UC-02, UC-03.1")
    s.box(SX, dt["det"] - 22, SW, 44, "Driver Trip Details", sub="UC-09")
    pair(s, AX + AW, dt["av"], 0, SX, dt["av"], '"Availability" [vehicle approved]', '"Trips"', size=L)
    pair(s, AX + AW, 835, 380, SX, dt["veh"], '"My Vehicle"', '"Trips"', size=L)
    pair(s, AX + AW, 850, 365, SX, dt["det"], '"View trip details"', "close", size=L)
    s.box(RX, dt["det"] - 22, RW, 44, "Confirm Unavailability", sub="UC-07 (FR-3.2, FR-5.1)")
    s.poly([(SX + SW, dt["det"] - 5), (RX, dt["det"] - 5)])
    s.poly([(RX, dt["det"] + 5), (SX + SW, dt["det"] + 5)])
    s.label(RX + RW, 877, '"Report unavailability"', "end", size=L)
    s.label(RX + RW, 941, "confirm / flag trip At-Risk; cancel", "end", size=L)

    # --- patient & caregiver ---
    YX, YY, YW, YH = 75, 1015, 190, 125
    s.box(YX, YY, YW, YH, "Patient Trips",
          ["do / display next pickup and status", "do / display owned journeys",
           "do / display notifications"], uc=["UC-10, UC-11"])
    ps = {"sch": 1030, "con": 1094, "ar": 1150, "det": 1215}
    s.box(SX, ps["sch"] - 18, SW, 36, "Patient Schedules")
    s.box(SX, ps["con"] - 22, SW, 44, "Caregiver Connections", sub="UC-02.1")
    s.box(SX, ps["ar"] - 22, SW, 44, "Add Reminder", sub="UC-13")
    pair(s, YX + YW, ps["sch"], 0, SX, ps["sch"], '"Schedules"', '"Trips"', size=L)
    pair(s, YX + YW, ps["con"], 0, SX, ps["con"], '"Caregivers" [role = Patient] /\n"Patient" [role = Caregiver]', '"Trips"', size=L)
    pair(s, YX + YW, 1122, 390, SX, ps["ar"], '"Add reminder"', "confirm / send event to\nCalendar Service; cancel", size=L)
    pair(s, YX + YW, 1134, 370, SX, ps["det"], '"View trip details"', "close", size=L)

    s.box(RX, ps["sch"] - 18, RW, 36, "Schedule Form")
    s.poly([(SX + SW, ps["sch"] - 5), (RX, ps["sch"] - 5)])
    s.poly([(RX, ps["sch"] + 5), (SX + SW, ps["sch"] + 5)])
    s.label(RX + RW, 994, '"Add Schedule" / "Edit Schedule"', "end", size=L)
    s.label(RX + RW + 6, 1013, "save / store\nschedule; cancel", size=L)
    s.box(RX, 1090, RW, 36, "Confirm Schedule Deletion")
    s.poly([(RX + 30, ps["sch"] + 18), (RX + 30, 1088)])
    s.poly([(RX + 140, 1088), (RX + 140, ps["sch"] + 20)])
    s.label(RX + 38, 1052, '"Delete Schedule"', size=L)
    s.label(RX + 38, 1069, "confirm / delete; cancel", size=L)

    s.box(RX + 190, ps["ar"] - 22, 92, 44, "Calendar\nService", dashed=True)
    s.poly([(SX + SW, ps["ar"]), (RX + 188, ps["ar"])], dashed=True)
    s.text(RX + 236, ps["ar"] + 36, "external", anchor="middle")

    # trip details, with the actions it offers hanging below it
    s.box(SX, ps["det"] - 22, 480, 44, "Patient Trip Details", sub="UC-09, UC-11")
    cy = 1330
    for x0, title, fwd, ret in (
            (SX, "Confirm Cancellation", '"Cancel trip"\n[trip upcoming]', "confirm / release\ncapacity; cancel"),
            (SX + 165, "Rate Driver", '"Rate driver"\n[trip completed]', "submit / record\nrating; cancel"),
            (SX + 330, "Preferred Driver", '"Preferred driver"', "save / set; remove /\nclear; cancel")):
        s.box(x0, cy - 22, 150, 44, title, sub="UC-11" if title.startswith("Confirm") else "UC-12")
        s.poly([(x0 + 12, ps["det"] + 22), (x0 + 12, cy - 24)])
        s.poly([(x0 + 140, cy - 24), (x0 + 140, ps["det"] + 24)])
        s.label(x0 + 18, ps["det"] + 26, fwd, size=L)
        s.label(x0 + 134, ps["det"] + 58, ret, "end", size=L)

    # --- guarded entry lanes from Login into each role map ---
    s.poly([(390, 66), (390, 86), (30, 86), (30, 440), (DX - 2, 440)])
    s.poly([(410, 66), (410, 120), (38, 120), (38, 815), (AX - 2, 815)])
    s.poly([(430, 66), (430, 154), (46, 154), (46, 1060), (YX - 2, 1060)])
    s.label(56, 69, "[role = Coordinator]", size=L)
    s.label(56, 103, "[role = Driver]", size=L)
    s.label(56, 137, "[role = Patient OR (Caregiver AND linked patients ≤ 1)]", size=L)

    # --- sign out, drawn once for all three entry states ---
    for sy in (470, 860, 1100):
        s.poly([(75, sy), (8, sy)], dashed=True, head=False)
    s.poly([(8, 1100), (8, 58), (328, 58)], dashed=True)
    s.label(14, 206, "sign out / clear session", size=L)

    # --- legend ---
    lx, ly = 52, 1382
    s.top.append(f'<rect x="{lx}" y="{ly}" width="898" height="60" rx="5" fill="#f8f7f3" stroke="#d9d5cb" stroke-width="1.2"/>')
    s.text(lx + 14, ly + 19, "Legend", 11.5, False, color=TXT, bold=True)
    s.top.append(f'<rect x="{lx+14}" y="{ly+28}" width="18" height="12" rx="2" fill="{FILL}" stroke="{STROKE}"/>')
    s.text(lx + 38, ly + 38, "Normal UI state", 10, False, color="#444")
    s.top.append(f'<rect x="{lx+150}" y="{ly+28}" width="18" height="12" rx="2" fill="{EXF}" stroke="{EXS}"/>')
    s.text(lx + 174, ly + 38, "Exception / failure state", 10, False, color="#444")
    s.top.append(f'<rect x="{lx+310}" y="{ly+28}" width="18" height="12" rx="2" fill="#fff" stroke="{STROKE}" stroke-dasharray="4 3"/>')
    s.text(lx + 334, ly + 38, "External participant (outside system boundary)", 10, False, color="#444")
    s.top.append(f'<line x1="{lx+600}" y1="{ly+34}" x2="{lx+624}" y2="{ly+34}" stroke="{ARROW}" stroke-width="1.4" stroke-dasharray="5 4"/>')
    s.text(lx + 630, ly + 38, "Sign-out transition", 10, False, color="#444")
    s.text(lx + 14, ly + 54, "Dashed grouping boxes are role maps, not states. Behaviour inside a state is written as event / action (internal transition); guards are in square brackets.", 10, False, color="#444")
    return s.svg()


# ================================================= Diagram 1: shared entry ===
def d1():
    s = SVG(900, 700)
    s.dot(120, 78)
    s.poly([(127, 78), (138, 78)])
    s.box(140, 60, 140, 36, "Login")
    s.path("M160,60 C 150,22 250,22 240,58")  # failed sign-in self-transition
    s.label(260, 14, "continue with Google [Google sign-in failed] / show inline error")

    # --- account creation on the landing card ---
    s.box(430, 60, 150, 36, "Create Account")
    s.box(680, 60, 150, 36, "Complete Details")
    pair(s, 280, 78, 0, 430, 78, "[no account record]", "Cancel / clear session\n(from either step)")
    pair(s, 580, 78, 0, 680, 78, "Next", "Back")

    # --- inactive account ---
    s.box(40, 200, 140, 36, "Account Inactive", exc=True)
    s.poly([(210, 96), (210, 130), (760, 130), (760, 98)])
    s.label(430, 110, "[role = Patient, owned profile incomplete]")
    s.poly([(150, 96), (150, 198)], exc=True)
    s.poly([(170, 198), (170, 98)], exc=True)
    s.label(190, 142, "[account inactive]", exc=True)
    s.label(190, 166, "sign out / clear session", exc=True)

    # --- role map entry states ---
    s.box(330, 330, 180, 36, "Coordinator Trips")
    s.box(330, 420, 180, 36, "Driver Trips")
    s.box(330, 510, 180, 36, "Patient Trips")
    s.poly([(230, 96), (230, 310), (360, 310), (360, 328)])
    s.poly([(250, 96), (250, 400), (380, 400), (380, 418)])
    s.poly([(270, 96), (270, 490), (400, 490), (400, 508)])
    s.label(240, 288, "[role = Coordinator]")
    s.label(260, 378, "[role = Driver]")
    s.label(250, 462, "[role = Patient OR (role = Caregiver\nAND linked patients ≤ 1)]")

    # sign up enters the Driver or Patient map directly
    s.poly([(700, 96), (700, 438), (512, 438)])
    s.poly([(730, 96), (730, 528), (512, 528)])
    s.label(690, 392, "Sign Up / save account\n[role = Driver]", "end")
    s.label(690, 470, "Sign Up / save account and owned\nprofile [role = Patient OR Caregiver]", "end")

    # --- caregiver patient scope ---
    s.box(680, 600, 150, 36, "Select Patient")
    s.poly([(280, 90), (405, 90), (405, 160), (860, 160), (860, 618), (832, 618)])
    s.label(420, 136, "[role = Caregiver AND linked patients > 1]")
    s.poly([(680, 618), (620, 618), (620, 536), (512, 536)])
    s.label(530, 556, "select linked patient")

    # --- My Account, shared by every role ---
    s.box(330, 610, 180, 36, "My Account")
    for y in (348, 438, 528):
        s.poly([(330, y), (300, y)], head=False)
    s.poly([(300, 348), (300, 628), (328, 628)])
    s.poly([(328, 620), (312, 620), (312, 348)])
    s.label(150, 556, '"My Account"')
    s.label(150, 576, '"Trips" / each role\'s menu pages')

    # --- sign out, drawn once from the Coordinator entry state ---
    s.poly([(330, 340), (14, 340), (14, 88), (138, 88)], dashed=True)
    s.label(30, 318, "sign out (from any function page) / clear session")

    s.text(24, 666, "Dashed arrow: sign out from any function page of any role map returns here.")
    s.text(24, 680, "Login, Create Account, Complete Details, Account Inactive, Select Patient and My Account belong to no role map; every active role reaches My Account.")
    s.text(24, 694, "Coordinator accounts are provisioned manually, so no sign-up path enters the Coordinator map.")
    return s.svg()


# ================================================== Diagram 2: coordinator ===
def d2():
    s = SVG(940, 1000)
    DX, DY, DW, DH = 40, 330, 250, 150
    s.dot(14, 405)
    s.poly([(21, 405), (DX - 2, 405)])
    s.box(DX, DY, DW, DH, "Coordinator Trips",
          ["do / display journeys by status and date", "search / filter / sort / update list",
           "select status tile / update list"],
          uc=["UC-04 (FR-6.1, FR-6.5)"])
    ex = DX + DW
    SX, SW = 520, 180
    RX, RW = 740, 180
    st = {"sched": 60, "pat": 195, "care": 270, "drv": 345, "del": 405, "match": 490,
          "det": 590, "rec": 680, "route": 790, "audit": 870}
    s.box(SX, st["sched"] - 18, SW, 36, "Coordinator Schedules")
    s.box(SX, st["pat"] - 18, SW, 36, "Patients")
    s.box(SX, st["care"] - 22, SW, 44, "Caregivers", sub="UC-02, UC-02.1")
    s.box(SX, st["drv"] - 22, SW, 44, "Drivers", sub="UC-02, UC-03.1")
    s.box(SX, st["del"] - 18, SW, 36, "Confirm Trip Deletion")
    s.box(SX, st["match"] - 18, SW, 36, "Match a Driver")
    s.box(SX, st["det"] - 22, SW, 44, "Coordinator Trip Details", sub="UC-04, UC-05")
    s.box(SX, st["route"] - 18, SW, 36, "Route & Traffic Monitor")
    s.box(SX, st["audit"] - 18, SW, 36, "Audit Log")
    pair(s, ex, 338, 320, SX, st["sched"], '"Schedules"', '"Trips"')
    pair(s, ex, 350, 335, SX, st["pat"], '"Patients"', '"Trips"')
    pair(s, ex, 362, 350, SX, st["care"], '"Caregivers"', '"Trips"')
    pair(s, ex, 374, 365, SX, st["drv"], '"Drivers"', '"Trips"')
    pair(s, ex, st["del"], 0, SX, st["del"], '"Delete Trip" [journey unassigned]', "confirm / delete journey,\nretain history; cancel")
    pair(s, ex, 432, 425, SX, st["match"], '"Assign driver" [trip unfilled]', "approve / assign driver; dismiss")
    pair(s, ex, 444, 410, SX, st["det"], '"View trip details"', "close")
    pair(s, ex, 456, 395, SX, st["route"], '"Routes"', "back")
    pair(s, ex, 468, 380, SX, st["audit"], '"Audit log"', "back")

    # recovery is offered on trip details, so Recovery Options hangs below it
    s.box(SX, st["rec"] - 18, SW, 36, "Recovery Options")
    s.poly([(SX + 20, st["det"] + 22), (SX + 20, st["rec"] - 20)])
    s.poly([(SX + 160, st["rec"] - 20), (SX + 160, st["det"] + 24)])
    s.label(SX + 28, st["det"] + 28, '"Generate recovery\noptions" [trip at-risk]')
    s.label(SX + 168, st["det"] + 28, "approve / apply option;\ndismiss")

    # a list state's own child, drawn to its right
    s.box(RX, st["sched"] - 18, RW, 36, "Generate Trips")
    s.poly([(SX + SW, st["sched"] - 5), (RX, st["sched"] - 5)])
    s.poly([(RX, st["sched"] + 5), (SX + SW, st["sched"] + 5)])
    s.label(RX + RW, st["sched"] + 23, '"Generate Trips" [schedule version current,\nsessions in supported range]', "end")
    s.label(RX + RW, st["sched"] + 60, "confirm / create unfilled outbound and\nreturn journeys; cancel", "end")

    s.box(RX, st["pat"] - 18, RW, 36, "Patient Details")
    s.poly([(SX + SW, st["pat"] - 5), (RX, st["pat"] - 5)])
    s.poly([(RX, st["pat"] + 5), (SX + SW, st["pat"] + 5)])
    s.label(RX + RW, st["pat"] - 40, "select record", "end")
    s.label(RX + RW, st["pat"] + 23, "save / update status and notes; cancel", "end")

    ey = st["rec"] - 18
    s.box(RX, ey, RW, 36, "Escalate Critical", exc=True)
    s.poly([(SX + SW, st["rec"]), (RX - 2, st["rec"])], exc=True)
    s.label(RX + 4, ey + 42, "[no feasible option]", exc=True)
    s.poly([(RX + RW, ey + 18), (930, ey + 18), (930, 24), (DX + 90, 24), (DX + 90, DY - 2)], exc=True)
    s.label(500, 14, "escalate / classify trip Unfilled-Critical", "middle", exc=True)

    uy = st["route"] - 18
    s.box(RX, uy, RW, 36, "Service Unavailable", exc=True)
    s.label(RX + 50, uy - 26, "[service timeout > 5 s]", exc=True)
    s.poly([(SX + SW, st["rec"] + 8), (RX, uy + 6)], exc=True)
    s.poly([(RX, uy + 14), (SX + SW, st["rec"] + 16)], exc=True)
    s.poly([(SX + SW, st["route"] + 4), (RX, uy + 22)], exc=True)
    s.poly([(RX, uy + 30), (SX + SW, st["route"] + 12)], exc=True)
    s.label(RX + 4, uy + 40, "retry / back\n(to originating screen)", exc=True)

    # shared states, drawn here as the targets they are
    s.poly([(70, DY + DH), (70, 888)])
    s.box(20, 890, 130, 36, "Login")
    s.label(78, 700, "sign out / clear session")
    s.box(200, 890, 150, 36, "My Account")
    s.poly([(260, DY + DH), (260, 888)])
    s.poly([(300, 888), (300, 860), (230, 860), (230, DY + DH + 2)])
    s.label(82, 744, '"My Account"')
    s.label(82, 766, '"Trips" / "Schedules" /\n"Patients" / "Drivers" /\n"Caregivers"')
    s.text(20, 952, "(shared states, section 2)")

    lx, ly = 510, 905
    s.top.append(f'<rect x="{lx}" y="{ly}" width="420" height="82" rx="5" fill="#f8f7f3" stroke="#d9d5cb" stroke-width="1.2"/>')
    s.text(lx + 14, ly + 19, "Legend", 11.5, False, color=TXT, bold=True)
    s.top.append(f'<rect x="{lx+14}" y="{ly+28}" width="18" height="12" rx="2" fill="{FILL}" stroke="{STROKE}"/>')
    s.text(lx + 40, ly + 38, "Normal UI state", 10.5, False, color="#444")
    s.top.append(f'<rect x="{lx+14}" y="{ly+46}" width="18" height="12" rx="2" fill="{EXF}" stroke="{EXS}"/>')
    s.text(lx + 40, ly + 56, "Exception / failure state", 10.5, False, color="#444")
    s.text(lx + 14, ly + 74, "Behaviour inside a state is written as event / action (internal transition)", 10.5, False, color="#444")
    return s.svg()


# ======================================================= Diagram 3: driver ===
def d3():
    s = SVG(820, 640)
    s.dot(14, 90)
    s.poly([(21, 90), (38, 90)])
    s.box(40, 12, 300, 165, "Driver Trips",
          ["do / display assigned pickups by date", "do / display notifications of trip changes",
           "filter by date / update list"],
          uc=["UC-04 Monitor Transport Operations (FR-6.1)", "UC-10 Notify Affected Users (FR-6.2)"])
    ex = 340
    SX, SW = 560, 240
    st = {"av": 50, "veh": 175, "det": 315}
    s.box(SX, st["av"] - 32, SW, 96, "Driver Availability",
          ["select week / show booked intervals", "edit week / save availability"], uc=["UC-06 (FR-3.1)"])
    s.box(SX, st["veh"] - 32, SW, 96, "My Vehicle",
          ["submit / send registration for review", "edit registration / resubmit"], uc=["UC-02, UC-03.1"])
    s.box(SX, st["det"] - 32, SW, 112, "Driver Trip Details",
          ["start trip / record actual start", "complete trip / record completion",
           "share location / publish position"], uc=["UC-09 Track Active Trip"])
    # the pair dropping furthest takes the innermost elbow, so the three never cross
    pair(s, ex, st["av"], 0, SX, st["av"], '"Availability"\n[vehicle registration approved]', '"Trips"')
    pair(s, ex, 100, 460, SX, st["veh"], '"My Vehicle"', '"Trips"')
    pair(s, ex, 140, 420, SX, st["det"], '"View trip details"', "close")

    cy = 470
    s.box(SX, cy - 22, SW, 44, "Confirm Unavailability", sub="UC-07 (FR-3.2, FR-5.1)")
    s.poly([(SX + 60, st["det"] + 80), (SX + 60, cy - 24)])
    s.poly([(SX + 110, cy - 24), (SX + 110, st["det"] + 82)])
    s.label(SX + 52, 410, '"Report unavailability"', "end")
    s.label(SX + 118, 410, "confirm / flag trip\nAt-Risk; cancel")

    # shared states, drawn here as the targets they are
    s.poly([(90, 177), (90, 538)])
    s.box(40, 540, 130, 36, "Login")
    s.label(100, 250, "sign out / clear session")
    s.box(230, 540, 150, 36, "My Account")
    s.poly([(180, 177), (180, 510), (280, 510), (280, 538)])
    s.poly([(330, 538), (330, 490), (240, 490), (240, 179)])
    s.label(260, 300, '"My Account"')
    s.label(260, 322, '"Trips" / "Availability" / "My Vehicle"')
    s.text(40, 602, "(shared states, section 2)")

    s.notebox(420, 512, 380, 100, "Note",
              [["Editing a week, the vehicle form, Start, Complete and location",
                "sharing change content in place, so they are internal transitions."],
               ["Reporting unavailability flags a trip At-Risk, so it is confirmed",
                "before the action is applied. It is offered on Driver Trip Details."]])
    return s.svg()


# ========================================== Diagram 4: patient & caregiver ===
def d4():
    s = SVG(960, 830)
    YX, YY, YW, YH = 40, 190, 300, 150
    s.dot(14, 260)
    s.poly([(21, 260), (38, 260)])
    s.box(YX, YY, YW, YH, "Patient Trips",
          ["do / display next pickup, status and review flag", "do / display owned journeys, filtered and paged",
           "do / display notifications of trip changes"],
          uc=["UC-10 Notify Affected Users,", "UC-11 View Upcoming Pickup"])
    ex = YX + YW
    SX, SW = 560, 180
    RX, RW = 780, 180
    st = {"sch": 80, "con": 252, "ar": 318}
    s.box(SX, st["sch"] - 18, SW, 36, "Patient Schedules")
    s.box(SX, st["con"] - 22, SW, 44, "Caregiver Connections", sub="UC-02.1")
    s.box(SX, st["ar"] - 22, SW, 44, "Add Reminder", sub="UC-13")
    pair(s, ex, 200, 420, SX, st["sch"], '"Schedules"', '"Trips"')
    pair(s, ex, st["con"], 0, SX, st["con"], '"Caregivers" [role = Patient] /\n"Patient" [role = Caregiver]', '"Trips"')
    pair(s, ex, st["ar"], 0, SX, st["ar"], '"Add reminder"', "confirm / send event to\nCalendar Service; cancel")

    # trip details, with the actions it offers hanging below it
    TX, TY, TW, TH = 420, 400, 520, 108
    s.box(TX, TY, TW, TH, "Patient Trip Details",
          ["acknowledge / record confirmation", "do / display route, progress and live position",
           "select Details / Journey / Rate tab / switch view"],
          uc=["UC-09 Track Active Trip, UC-11 View Upcoming Pickup"])
    pair(s, ex, 334, 380, TX, 440, '"View trip details"', "close", lab_right=372)
    cy = 622
    for x0, title, sub, fwd, ret in (
            (420, "Confirm Cancellation", "UC-11", '"Cancel trip"\n[trip upcoming]', "confirm / release\ncapacity; cancel"),
            (600, "Rate Driver", "UC-12", '"Rate driver"\n[trip completed]', "submit / record\nrating; cancel"),
            (780, "Preferred Driver", "UC-12", '"Preferred driver"', "save / set; remove /\nclear; cancel")):
        s.box(x0, cy - 22, 160, 44, title, sub=sub)
        s.poly([(x0 + 15, TY + TH), (x0 + 15, cy - 24)])
        s.poly([(x0 + 148, cy - 24), (x0 + 148, TY + TH + 2)])
        s.label(x0 + 22, TY + TH + 6, fwd)
        s.label(x0 + 141, TY + TH + 52, ret, "end")

    # treatment schedule entry, owned by the Patient
    s.box(RX, st["sch"] - 18, RW, 36, "Schedule Form")
    s.poly([(SX + SW, st["sch"] - 5), (RX, st["sch"] - 5)])
    s.poly([(RX, st["sch"] + 5), (SX + SW, st["sch"] + 5)])
    s.label(RX + RW, 18, '"Add Schedule" / "Edit Schedule"', "end")
    s.label(RX + RW, 40, "save / store treatment schedule; cancel", "end")
    s.box(RX, 160, RW, 36, "Confirm Schedule Deletion")
    s.poly([(RX + 50, st["sch"] + 18), (RX + 50, 158)])
    s.poly([(RX + 130, 158), (RX + 130, st["sch"] + 20)])
    s.label(RX + 42, 104, '"Delete Schedule"', "end")
    s.label(RX + 42, 126, "confirm / delete schedule and linked\nreplacements; cancel", "end")

    s.box(800, st["ar"] - 22, 100, 44, "Calendar\nService", dashed=True)
    s.poly([(SX + SW, st["ar"]), (798, st["ar"])], dashed=True)
    s.text(850, st["ar"] + 38, "external", anchor="middle")

    # shared states, drawn here as the targets they are
    s.poly([(90, YY + YH), (90, 678)])
    s.box(40, 680, 130, 36, "Login")
    s.label(100, 440, "sign out / clear session")
    s.box(230, 680, 150, 36, "My Account")
    s.poly([(180, YY + YH), (180, 650), (280, 650), (280, 678)])
    s.poly([(330, 678), (330, 620), (240, 620), (240, YY + YH + 2)])
    s.label(250, 520, '"My Account"')
    s.label(250, 542, '"Trips" / "Schedules" /\n"Caregivers" / "Patient"')
    s.text(40, 744, "(shared states, section 2)")

    s.notebox(420, 662, 520, 160, "Notes",
              [["Calendar Service is outside the system boundary, so it is drawn as an external",
                "participant, not a state. Only Add Reminder belongs to this system."],
               ["Rating and preferred-driver management are separated: the first is post-trip",
                "feedback, the second a standing preference with a different lifetime."],
               ["Caregivers share this map for their currently linked Patients. Generating, entering",
                "and confirming a link code and unlinking are internal to Caregiver Connections."],
               ["Editing owned details happens in place on My Account, so it is an internal transition."]])
    return s.svg()


# ============================================== Section 6: transition table ===
# (From, Event, Guard, Action, To). A dash in Event means the guard alone fires it.
ROWS = [
    ("Login", "continue with Google", "[account active, role = Coordinator]", "—", "Coordinator Trips"),
    ("Login", "continue with Google", "[account active, role = Driver]", "—", "Driver Trips"),
    ("Login", "continue with Google", "[account active, role = Patient, owned profile complete]", "—", "Patient Trips"),
    ("Login", "continue with Google", "[role = Caregiver, linked patients ≤ 1]", "—", "Patient Trips"),
    ("Login", "continue with Google", "[role = Caregiver, linked patients &gt; 1]", "—", "Select Patient"),
    ("Login", "continue with Google", "[no account record]", "—", "Create Account"),
    ("Login", "continue with Google", "[role = Patient, owned profile incomplete]", "—", "Complete Details"),
    ("Login", "continue with Google", "[account inactive]", "—", "Account Inactive"),
    ("Login", "continue with Google", "[Google sign-in failed]", "show inline error", "Login (self)"),
    ("Create Account", "Next", "—", "—", "Complete Details"),
    ("Create Account", "change Google account", "—", "restart Google selection", "Create Account (self)"),
    ("Create Account", "Cancel", "—", "clear session", "Login"),
    ("Complete Details", "Back", "—", "—", "Create Account"),
    ("Complete Details", "Sign Up", "[role = Patient]", "save account and owned patient profile", "Patient Trips"),
    ("Complete Details", "Sign Up", "[role = Caregiver]", "save account", "Patient Trips"),
    ("Complete Details", "Sign Up", "[role = Driver]", "save account", "Driver Trips"),
    ("Complete Details", "Cancel", "—", "clear session", "Login"),
    ("Account Inactive", "sign out", "—", "clear session", "Login"),
    ("Select Patient", "select linked patient", "—", "set session scope to patient", "Patient Trips"),
    ("any function page (all role maps)", '"My Account"', "—", "—", "My Account"),
    ("My Account", '"Trips"', "[role = Coordinator]", "—", "Coordinator Trips"),
    ("My Account", '"Trips"', "[role = Driver]", "—", "Driver Trips"),
    ("My Account", '"Trips"', "[role = Patient OR Caregiver]", "—", "Patient Trips"),
    ("My Account", '"Schedules"', "[role = Coordinator]", "—", "Coordinator Schedules"),
    ("My Account", '"Schedules"', "[role = Patient OR Caregiver]", "—", "Patient Schedules"),
    ("My Account", '"Patients"', "[role = Coordinator]", "—", "Patients"),
    ("My Account", '"Caregivers"', "[role = Coordinator]", "—", "Caregivers"),
    ("My Account", '"Drivers"', "[role = Coordinator]", "—", "Drivers"),
    ("My Account", '"Availability"', "[role = Driver, vehicle registration approved]", "—", "Driver Availability"),
    ("My Account", '"My Vehicle"', "[role = Driver]", "—", "My Vehicle"),
    ("My Account", '"Caregivers"', "[role = Patient]", "—", "Caregiver Connections"),
    ("My Account", '"Patient"', "[role = Caregiver]", "—", "Caregiver Connections"),
    ("My Account", "edit", "[role = Patient]", "unlock owned details", "My Account (self)"),
    ("My Account", "save", "[role = Patient, version current]", "update owned profile", "My Account (self)"),
    ("My Account", "cancel", "[role = Patient]", "discard changes", "My Account (self)"),
    ("My Account", "—", "[role = Patient, owned profile missing]", "—", "Complete Details"),
    ("any Coordinator function page", '"Trips"', "—", "—", "Coordinator Trips"),
    ("any Coordinator function page", '"Schedules"', "—", "—", "Coordinator Schedules"),
    ("any Coordinator function page", '"Patients"', "—", "—", "Patients"),
    ("any Coordinator function page", '"Caregivers"', "—", "—", "Caregivers"),
    ("any Coordinator function page", '"Drivers"', "—", "—", "Drivers"),
    ("Coordinator Schedules", '"Generate Trips"', "[schedule version current, sessions in supported range]", "—", "Generate Trips"),
    ("Generate Trips", "confirm", "[future range ≤ 90 days]", "create unfilled outbound and return journeys", "Coordinator Schedules"),
    ("Generate Trips", "cancel", "—", "—", "Coordinator Schedules"),
    ("Coordinator Trips", '"Delete Trip"', "[journey unassigned]", "—", "Confirm Trip Deletion"),
    ("Confirm Trip Deletion", "confirm", "[version current]", "delete journey, retain history", "Coordinator Trips"),
    ("Confirm Trip Deletion", "cancel", "—", "—", "Coordinator Trips"),
    ("Coordinator Trips", '"Assign driver"', "[trip unfilled]", "—", "Match a Driver"),
    ("Match a Driver", "approve", "—", "assign driver", "Coordinator Trips"),
    ("Match a Driver", "dismiss", "—", "—", "Coordinator Trips"),
    ("Coordinator Trips", '"View trip details"', "—", "—", "Coordinator Trip Details"),
    ("Coordinator Trip Details", "close", "—", "—", "Coordinator Trips"),
    ("Coordinator Trip Details", '"Generate recovery options"', "[trip at-risk]", "—", "Recovery Options"),
    ("Recovery Options", "approve", "—", "apply recovery option", "Coordinator Trip Details"),
    ("Recovery Options", "dismiss", "—", "—", "Coordinator Trip Details"),
    ("Recovery Options", "—", "[no feasible option]", "—", "Escalate Critical"),
    ("Recovery Options", "—", "[service timeout &gt; 5 s]", "—", "Service Unavailable"),
    ("Escalate Critical", "escalate", "—", "classify trip Unfilled-Critical", "Coordinator Trips"),
    ("Coordinator Trips", '"Routes"', "—", "—", "Route &amp; Traffic Monitor"),
    ("Route &amp; Traffic Monitor", "back", "—", "—", "Coordinator Trips"),
    ("Route &amp; Traffic Monitor", "—", "[service timeout &gt; 5 s]", "—", "Service Unavailable"),
    ("Service Unavailable", "retry / back", "[entered from Route &amp; Traffic Monitor]", "—", "Route &amp; Traffic Monitor"),
    ("Service Unavailable", "retry / back", "[entered from Recovery Options]", "—", "Recovery Options"),
    ("Coordinator Trips", '"Audit log"', "—", "—", "Audit Log"),
    ("Audit Log", "back", "—", "—", "Coordinator Trips"),
    ("Patients", "select record", "—", "—", "Patient Details"),
    ("Patient Details", "save", "[version current]", "update status and notes", "Patients"),
    ("Patient Details", "cancel", "—", "—", "Patients"),
    ("any Driver function page", '"Trips"', "—", "—", "Driver Trips"),
    ("any Driver function page", '"Availability"', "[vehicle registration approved]", "—", "Driver Availability"),
    ("any Driver function page", '"My Vehicle"', "—", "—", "My Vehicle"),
    ("Driver Trips", '"View trip details"', "—", "—", "Driver Trip Details"),
    ("Driver Trip Details", "close", "—", "—", "Driver Trips"),
    ("Driver Trip Details", '"Report unavailability"', "—", "—", "Confirm Unavailability"),
    ("Confirm Unavailability", "confirm", "—", "flag trip At-Risk", "Driver Trip Details"),
    ("Confirm Unavailability", "cancel", "—", "—", "Driver Trip Details"),
    ("any Patient or Caregiver function page", '"Trips"', "—", "—", "Patient Trips"),
    ("any Patient or Caregiver function page", '"Schedules"', "—", "—", "Patient Schedules"),
    ("any Patient or Caregiver function page", '"Caregivers"', "[role = Patient]", "—", "Caregiver Connections"),
    ("any Patient or Caregiver function page", '"Patient"', "[role = Caregiver]", "—", "Caregiver Connections"),
    ("Patient Schedules", '"Add Schedule" / "Edit Schedule"', "—", "—", "Schedule Form"),
    ("Schedule Form", "save", "[version current, no overlapping session]", "store treatment schedule", "Patient Schedules"),
    ("Schedule Form", "cancel", "—", "—", "Patient Schedules"),
    ("Schedule Form", '"Delete Schedule"', "[schedule owned]", "—", "Confirm Schedule Deletion"),
    ("Confirm Schedule Deletion", "confirm", "—", "delete schedule and linked replacements", "Patient Schedules"),
    ("Confirm Schedule Deletion", "cancel", "—", "—", "Schedule Form"),
    ("Patient Trips", '"View trip details"', "—", "—", "Patient Trip Details"),
    ("Patient Trip Details", "close", "—", "—", "Patient Trips"),
    ("Patient Trip Details", '"Cancel trip"', "[trip upcoming]", "—", "Confirm Cancellation"),
    ("Confirm Cancellation", "confirm", "—", "release driver capacity", "Patient Trip Details"),
    ("Confirm Cancellation", "cancel", "—", "—", "Patient Trip Details"),
    ("Patient Trip Details", '"Rate driver"', "[trip completed AND role = Patient]", "—", "Rate Driver"),
    ("Rate Driver", "submit", "—", "record rating", "Patient Trip Details"),
    ("Rate Driver", "cancel", "—", "—", "Patient Trip Details"),
    ("Patient Trip Details", '"Preferred driver"', "[role = Patient]", "—", "Preferred Driver"),
    ("Preferred Driver", "save", "—", "set preferred driver", "Patient Trip Details"),
    ("Preferred Driver", "remove", "—", "clear preferred driver", "Patient Trip Details"),
    ("Preferred Driver", "cancel", "—", "—", "Patient Trip Details"),
    ("Patient Trips", '"Add reminder"', "—", "—", "Add Reminder"),
    ("Add Reminder", "confirm", "—", "send event to Calendar Service", "Patient Trips"),
    ("Add Reminder", "cancel", "—", "—", "Patient Trips"),
    ("any function page (all role maps)", "sign out", "—", "clear session", "Login"),
]


def table():
    head = "<tr><th>From</th><th>Event</th><th>Guard</th><th>Action</th><th>To</th></tr>"
    body = "".join("<tr>" + "".join(f"<td>{c}</td>" for c in r) + "</tr>" for r in ROWS)
    return f"<table><thead>{head}</thead><tbody>{body}</tbody></table>"


CSS = """
@page { size: A4; margin: 18mm 17mm 18mm 18mm; }
body { font-family: Arial, 'Liberation Sans', sans-serif; font-size: 10.6pt; color: #222; line-height: 1.45; }
h1 { font-size: 25pt; margin: 0 0 4pt; }
.sub { color: #777; font-size: 10pt; margin-bottom: 12pt; }
h2 { font-size: 16.5pt; margin: 20pt 0 8pt; page-break-after: avoid; }
h3 { font-size: 12pt; margin: 14pt 0 4pt; page-break-after: avoid; }
ul { margin: 4pt 0; padding-left: 16pt; }
li { margin: 2pt 0; }
code { white-space: nowrap; font-family: Consolas, 'DejaVu Sans Mono', monospace; font-size: 9pt;
       background: #f0f0f0; padding: 0 3px; border-radius: 3px; }
hr { border: none; border-top: 1px solid #ccc; margin: 14pt 0; }
.sec { page-break-inside: avoid; }
.fig { margin: 8pt 0 4pt; page-break-inside: avoid; }
.fig svg { width: 100%; height: auto; display: block; }
table { border-collapse: collapse; width: 100%; font-size: 8.8pt; margin-top: 6pt; }
th, td { border: 1px solid #cfcfcf; padding: 3pt 5pt; text-align: left; vertical-align: top; }
th { background: #f1ede6; }
tr { page-break-inside: avoid; }
thead { display: table-header-group; }
.pb { page-break-before: always; }
.sec.pb { page-break-before: always; }
"""


def build():
    return f"""<!DOCTYPE html><html><head><meta charset="utf-8"><title>Dynamic Model — Dialog Map</title><style>{CSS}</style></head><body>
<h1>Dynamic Model — Dialog Map</h1>
<div class="sub">SC2006 Team 4 · Dialysis Transport Coordination System · Lab 2 Deliverable</div>
<p>This document models the system's behaviour as a state machine of user interface screens, following Lab 2 §3.3.1. States are UI screens; transitions are user actions or system events. The model follows the routes and screens the system provides; states that are designed but have no data path behind them yet are identified in the design notes.</p>
<h3>Modelling conventions</h3>
<ul>
<li>A screen is a separate <b>state</b> only where the set of available actions changes. Filtering, sorting and expanding content in place are <b>internal transitions</b>, written inside the state box as <code>event / action</code>.</li>
<li><code>do /</code> denotes a continuous activity while the state is active. Event-driven behaviour that completes is written as an internal transition, not as <code>do /</code>.</li>
<li>Guards are written in square brackets on the transition to which they apply.</li>
<li>Exception and failure states are shaded differently from normal UI states.</li>
<li>External systems outside the system boundary are drawn with a dashed outline and are not states.</li>
</ul>
<hr>
<div class="sec"><h2>1. Complete Dialog Map</h2>
<div class="fig">{d0()}</div></div>
<h3>How to read this map</h3>
<ul>
<li>This is the whole model in one diagram. Login, Create Account, Complete Details, Account Inactive, Select Patient and My Account belong to no role map and are shared by every role; the three dashed groupings are the Coordinator, Driver and Patient/Caregiver maps reached after authentication. The groupings are drawing conventions, not states.</li>
<li>Sections 3–5 redraw each grouping on its own, at a larger size and with its own design notes. No state or transition appears in those sections that is not in this map, and none in this map is omitted from them. Login and My Account appear there as the shared targets they are; both are defined in Section 2.</li>
<li>The guarded transitions out of Login determine which map the session enters. Each authenticated session is bound to a single role (FR-1.3), so only one grouping is reachable per session.</li>
<li>Sign-out is drawn once, as the dashed line running from all three entry states back to Login, rather than repeated on every state.</li>
<li>Section 6 lists every transition in tabular form and is the formal statement of the model.</li>
</ul>
<div class="sec"><h2>2. Shared Entry</h2>
<div class="fig">{d1()}</div></div>
<h3>Design notes</h3>
<ul>
<li>Coordinator Trips, Driver Trips and Patient Trips are the entry points into the three role maps in Sections 3–5. They are one route, <code>/dashboard/trips</code>, rendered for the role of the session; <code>/dashboard</code> only redirects to it, so the model carries no separate landing state.</li>
<li>Authentication is Google OAuth, so Login carries no credential form. A failed sign-in is modelled as a <b>self-transition</b> on Login carrying the action <code>show inline error</code>. While the service health check fails, the sign-in control is disabled; that is a condition of the state, not a transition.</li>
<li><b>Create Account</b> and <b>Complete Details</b> are the two sign-up steps on the landing card. Next and Back only move between them and change no stored data; the account and, for a Patient, the owned profile are saved atomically on Sign Up. Only Patient, Caregiver and Driver can be chosen, so no sign-up path enters the Coordinator map — coordinators are provisioned manually. A Patient whose owned profile is incomplete enters Complete Details instead, whether that is detected at Login or later on My Account.</li>
<li><b>Account Inactive</b> is a state rather than an inline message. An authenticated account that is not active reaches a screen whose only exit is sign out, so an inactive account cannot proceed into a role map.</li>
<li><b>My Account</b> belongs to no role map: every active role reaches it from any function page and returns through the same navigation. A Patient edits their owned details in place on this screen, so edit, save and cancel are internal transitions, not a separate form state. Notifications are likewise a header panel available on every function page, not a state.</li>
<li>Caregivers authenticate through the same Patient entry point using their own account. A Caregiver linked to at most one Patient transitions directly to Patient Trips, under the same guarded transition as a Patient; a Caregiver linked to more than one Patient passes through <b>Select Patient</b> first, since the system cannot determine the scope of the session without that choice. Caregiver linking (UC-02.1) is implemented, but the shipped screens show a Caregiver every linked Patient's journeys together and choose the Patient inside the schedule form, so no screen yet performs this selection.</li>
<li>Signing out from any function page returns to Login rather than to a final state, because the application does not terminate on sign-out. Each authenticated session is bound to a single role (FR-1.3), so only one role map is reachable per session.</li>
<li>Related use case: UC-01 Authenticate User (FR-1.2, FR-1.3, NFR-5.1, NFR-5.2).</li>
</ul>
<div class="sec"><h2>3. Coordinator</h2>
<div class="fig">{d2()}</div></div>
<h3>Design notes</h3>
<ul>
<li>Coordinator Trips carries the UC-04 status categories. Its status tiles, search, filters, sorting and pagination change content within the same screen, so they are internal transitions, not states. The same holds for the Patients, Caregivers, Drivers and Coordinator Schedules lists, whose record-detail and edit dialogs also act in place.</li>
<li><b>Coordinator Trip Details</b> is the routed page <code>/dashboard/trips/:tripId</code>. It is a state because its actions differ from the list's, and it is drawn once per role map, as Trips is, because those actions differ by role. Recovery is offered only here, so Recovery Options is entered from it and returns to it.</li>
<li>Guards are shown on the transitions: "Assign driver" is available only on Unfilled trips, "Generate recovery options" only on At-Risk trips, and "Delete Trip" only on a journey with no driver assigned.</li>
<li><b>Coordinator Schedules</b> is read-only: treatment requirements are recorded by the Patient, not the coordinator. <b>Generate Trips</b> replaces the New Trip state of the earlier model. Journeys are derived from a selected treatment schedule over a bounded future range using the treatment times and the standard 15-minute buffer (UC-03), rather than typed in by hand, and generation is idempotent.</li>
<li><b>Patients</b> covers UC-02. Record creation belongs to sign-up and deletion is not permitted, so Patient Details carries neither an "add new" transition nor an archive action; a coordinator may save only Status and Notes.</li>
<li><b>Confirm Trip Deletion</b> is a state for the same reason as the other confirmations: removing a journey cannot be undone from the list. It applies only to an unassigned journey, and the journey's history is retained.</li>
<li><b>Escalate Critical</b> covers FR-5.4. Where the system can generate no feasible recovery option, the trip is classified Unfilled-Critical and escalated for manual intervention rather than silently returning the coordinator to Coordinator Trips. The only exit is <code>escalate</code>, so a trip in this state cannot be left without being escalated.</li>
<li><b>Service Unavailable</b> covers the external-dependency failure implied by FR-4.1, FR-4.2 and NFR-2.1. Where routing or traffic data cannot be retrieved within the five-second bound, the coordinator is shown a recoverable failure state rather than stale or absent data. The same exception applies to Recovery Options, which depends on the same services; retry or back returns the coordinator to whichever of the two screens raised it.</li>
<li>Match a Driver and Recovery Options are implemented. Route &amp; Traffic Monitor and Audit Log are modelled as the use cases require them; the shipped app presents route, traffic and history data for each trip on its details page rather than as separate screens.</li>
<li><b>Caregivers</b> and <b>Drivers</b> are coordinator function pages reached through the header navigation. Driver account status, vehicle approval and rejection, and caregiver status are edited in place on them.</li>
<li>The Audit Log serves UC-04 (alternative flow: view audit log) and FR-6.4.</li>
<li>Related use cases: UC-02 Manage Patient Records, UC-03 Manage Treatment and Transport Schedules, UC-04 Monitor Transport Operations, UC-05 Resolve At-Risk Trip, UC-08 Assess Route and ETA.</li>
</ul>
<div class="sec"><h2>4. Driver</h2>
<div class="fig">{d3()}</div></div>
<h3>Design notes</h3>
<ul>
<li>Driver Trips is the Trips function page rendered for a Driver: assigned pickups by date. When no pickups are assigned it says so rather than inventing trips.</li>
<li><b>Driver Availability</b> and <b>My Vehicle</b> are separate routes. Availability is reachable once a vehicle registration has been approved; before that the menu offers Register Vehicle, which is the same My Vehicle state. Editing a week is an internal transition (<code>edit week / save availability</code>), not a <code>do /</code> activity, because it is triggered by a user event and completes.</li>
<li><b>Driver Trip Details</b> carries Start, Complete and location sharing as internal transitions, and is where unavailability is reported.</li>
<li>Notifications appear in-page, in the shared header panel, so they are modelled as a display activity on this state rather than as a separate screen.</li>
<li><b>Confirm Unavailability</b> is modelled as a state. Reporting unavailability flags the trip At-Risk and requires coordinator intervention (FR-5.1), so it is confirmed before the action is applied rather than being a single irreversible tap.</li>
<li>Related use cases: UC-06 Manage Driver Availability, UC-07 Report Driver Unavailability, UC-10 Notify Affected Users.</li>
</ul>
<div class="sec"><h2>5. Patient &amp; Caregiver</h2>
<div class="fig">{d4()}</div></div>
<h3>Design notes</h3>
<ul>
<li>Patient Trips is a single scrolling page carrying the next pickup — its pickup status, journey date and direction and any review flag — above a date-filtered, paged list of owned journeys. Route addresses, the treatment-derived constraints and live progress are on <b>Patient Trip Details</b>, the routed page <code>/dashboard/trips/:tripId</code>. There is no separate tracking screen.</li>
<li><b>Patient Schedules</b> serves both roles: a Caregiver reaches it for their linked Patients. <b>Caregiver Connections</b> is the linking page (UC-02.1); generating, entering and confirming an invitation code and unlinking are internal transitions on it. <b>Schedule Form</b> covers both adding and editing a treatment schedule; the whole-series / one-session scope choice inside it changes the same form, so it is an internal transition. <b>Confirm Schedule Deletion</b> is a state because deleting a series also deletes its linked replacements.</li>
<li>Acknowledging an upcoming trip acts in place on Patient Trip Details and is an internal transition. Cancelling does not: <b>Confirm Cancellation</b> is a state, because cancelling a dialysis journey releases driver capacity and cannot be undone by the patient. It carries the guard <code>[trip upcoming]</code>, since a completed trip cannot be cancelled.</li>
<li><b>Rate Driver</b> carries the guard <code>[trip completed AND role = Patient]</code>. A trip that has not taken place cannot be rated, and rating is the Patient's own: a Caregiver is not routed to it. <b>Preferred Driver</b> carries <code>[role = Patient]</code> for the same reason.</li>
<li>Rating and preferred-driver management are modelled as two states rather than one. They have different triggers and different lifetimes: one is feedback on a completed trip, the other a standing preference that persists across trips. Both trace to UC-12.</li>
<li><b>Calendar Service</b> is outside the system boundary and is therefore drawn as an external participant, not as a state. The state belonging to this system is <b>Add Reminder</b>; the call to the external service is an action on the confirm transition. Calendar synchronisation is not implemented, so Add Reminder is designed but has no data path behind it yet.</li>
<li>This map is shared by Patients and Caregivers under the login assumption in Section 2. A Caregiver acts only for currently linked Patients and may acknowledge or cancel their trips; rating and preferred-driver management stay the Patient's own.</li>
<li>Related use cases: UC-09 Track Active Trip, UC-10 Notify Affected Users, UC-11 View Upcoming Pickup, UC-12 Manage Driver Feedback and Preference, UC-13 Manage Calendar Reminders.</li>
</ul>
<h2 class="pb">6. Transition Summary</h2>
<p>The transitions below are the formal statement of the model; the diagrams are their visual form. A dash in the Event column denotes a transition triggered by its guard becoming true rather than by a user action. Header navigation is listed once per role: "any Coordinator function page" is Coordinator Trips, Coordinator Schedules, Patients, Caregivers, Drivers or Coordinator Trip Details; "any Driver function page" is Driver Trips, Driver Availability, My Vehicle or Driver Trip Details; "any Patient or Caregiver function page" is Patient Trips, Patient Schedules, Caregiver Connections or Patient Trip Details.</p>
{table()}
</body></html>"""


if __name__ == "__main__":
    import pathlib
    here = pathlib.Path(__file__).parent
    html_path = here / "dialog_map.html"
    pdf_path = here / "Dynamic_Model_Dialog_Map.pdf"
    html_path.write_text(build(), encoding="utf-8")
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page()
        pg.goto(html_path.as_uri())
        pg.pdf(path=str(pdf_path), format="A4", prefer_css_page_size=True, print_background=True)
        b.close()
    print(f"wrote {pdf_path}")
