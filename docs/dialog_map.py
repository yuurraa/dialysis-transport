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
    s = SVG(920, 1335)

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
    s.poly([(760, 102), (885, 102), (885, 850), (180, 850), (180, 842)])
    s.poly([(760, 110), (900, 110), (900, 1245), (180, 1245), (180, 1127)])
    s.label(915, 140, "Sign Up / save account\n[role = Driver]", "end", size=L)
    s.label(915, 190, "Sign Up / save account and owned\nprofile [role = Patient OR Caregiver]", "end", size=L)

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
    s.poly([(58, 32), (20, 32), (20, 1100)], head=False)
    s.poly([(20, 300), (20, 34), (57, 34)])
    for ty in (500, 830, 1100):
        s.poly([(20, ty), (71, ty)])
    s.label(100, 164, '"My Account"', size=L)
    s.label(100, 182, '"Trips" / "Schedules" / "Patients"', size=L)

    # ---- role map groupings ----
    s.region(52, 225, 818, 465, "Coordinator")
    s.region(52, 705, 818, 155, "Driver")
    s.region(52, 875, 818, 375, "Patient & Caregiver")

    # --- coordinator ---
    DX, DY, DW, DH = 75, 400, 190, 125
    s.box(DX, DY, DW, DH, "Coordinator Trips",
          ["do / display journeys by status", "search / filter / update list",
           "select tile / update list", "select journey / expand detail"], uc=["UC-04 (FR-6.1, FR-6.5)"])
    ex = DX + DW
    SX, SW = 450, 165
    RX, RW = 655, 165
    st = {"sched": 290, "pat": 348, "del": 406, "match": 464, "rec": 522, "route": 580, "audit": 638}
    s.box(SX, st["sched"] - 18, SW, 36, "Coordinator Schedules")
    s.box(SX, st["pat"] - 18, SW, 36, "Patients")
    s.box(SX, st["del"] - 18, SW, 36, "Confirm Trip Deletion")
    s.box(SX, st["match"] - 18, SW, 36, "Match a Driver")
    s.box(SX, st["rec"] - 18, SW, 36, "Recovery Options")
    s.box(SX, st["route"] - 18, SW, 36, "Route & Traffic Monitor")
    s.box(SX, st["audit"] - 18, SW, 36, "Audit Log")
    pair(s, ex, 405, 290, SX, st["sched"], '"Schedules"', '"Trips"', size=L)
    pair(s, ex, 420, 305, SX, st["pat"], '"Patients"', '"Trips"', size=L)
    pair(s, ex, 435, 320, SX, st["del"], '"Delete Trip" [journey unassigned]', "confirm / delete journey; cancel", size=L)
    pair(s, ex, 450, 335, SX, st["match"], '"Assign driver" [trip unfilled]', "approve / assign driver; dismiss", size=L)
    pair(s, ex, 465, 350, SX, st["rec"], '"Compare options" [trip at-risk]', "approve / apply option; dismiss", size=L)
    pair(s, ex, 480, 365, SX, st["route"], '"Routes"', "back", size=L)
    pair(s, ex, 495, 380, SX, st["audit"], '"Audit log"', "back", size=L)

    s.box(RX, st["sched"] - 18, RW, 36, "Generate Trips")
    s.poly([(SX + SW, st["sched"] - 5), (RX, st["sched"] - 5)])
    s.poly([(RX, st["sched"] + 5), (SX + SW, st["sched"] + 5)])
    s.label(RX + RW, 248, '"Generate Trips" [schedule generatable]', "end", size=L)
    s.label(RX + RW, 312, "confirm / create unfilled journeys; cancel", "end", size=L)

    s.box(RX, st["pat"] - 18, RW, 36, "Patient Details")
    s.poly([(SX + SW, st["pat"] - 5), (RX, st["pat"] - 5)])
    s.poly([(RX, st["pat"] + 5), (SX + SW, st["pat"] + 5)])
    s.label(RX + RW, 370, "select record", "end", size=L)
    s.label(RX + RW, 392, "save / update status and notes; cancel", "end", size=L)

    # escalate critical — only exit is escalate, back to Coordinator Trips
    s.box(RX, 460, RW, 36, "Escalate Critical", exc=True)
    s.poly([(SX + SW, st["rec"] - 6), (RX, 490)], exc=True)
    s.label(RX + 2, 500, "[no feasible option]", exc=True, size=L)
    s.poly([(RX + RW, 478), (845, 478), (845, 240), (170, 240), (170, DY - 2)], exc=True)
    s.label(400, 226, "escalate / classify trip Unfilled-Critical", "middle", exc=True, size=L)

    # service unavailable — raised by Recovery Options and Route & Traffic Monitor
    s.box(RX, 620, RW, 36, "Service Unavailable", exc=True)
    s.label(RX + 2, 600, "[service timeout > 5 s]", exc=True, size=L)
    s.poly([(SX + SW, st["rec"] + 6), (RX, 630)], exc=True)
    s.poly([(RX, 638), (SX + SW, st["rec"] + 14)], exc=True)
    s.poly([(SX + SW, st["route"] + 6), (RX, 646)], exc=True)
    s.poly([(RX, 654), (SX + SW, st["route"] + 14)], exc=True)
    s.label(RX + 2, 660, "retry / back (to originating screen)", exc=True, size=L)

    # --- driver ---
    AX, AY, AW, AH = 75, 725, 330, 115
    s.box(AX, AY, AW, AH, "Driver Trips",
          ["do / display assigned pickups with route and ETA", "do / display notifications of trip changes",
           "toggle availability slot / update availability", "select trip / expand detail"],
          uc=["UC-06 (FR-3.1), UC-10 (FR-6.2)"])
    s.box(600, 760, 210, 44, "Confirm Unavailability", sub="UC-07 (FR-3.2, FR-5.1)")
    pair(s, AX + AW, 782, 0, 600, 782, '"Report unavailable"', "confirm / flag trip At-Risk; cancel", lab_right=592, size=L)

    # --- patient & caregiver ---
    YX, YY, YW, YH = 75, 990, 205, 135
    s.box(YX, YY, YW, YH, "Patient Trips",
          ["do / display next pickup and status", "do / display owned journeys",
           "do / display notifications", "confirm trip / record confirmation",
           "select journey / expand detail"], uc=["UC-09, UC-10, UC-11"])
    PX, PW = 450, 165
    QX, QW = 660, 165
    ps = {"sch": 925, "cc": 985, "rd": 1055, "pd": 1125, "ar": 1195}
    s.box(PX, ps["sch"] - 18, PW, 36, "Patient Schedules")
    s.box(PX, ps["cc"] - 22, PW, 44, "Confirm Cancellation", sub="UC-11")
    s.box(PX, ps["rd"] - 22, PW, 44, "Rate Driver", sub="UC-12")
    s.box(PX, ps["pd"] - 22, PW, 44, "Preferred Driver", sub="UC-12")
    s.box(PX, ps["ar"] - 22, PW, 44, "Add Reminder", sub="UC-13")
    pair(s, YX + YW, 1000, 300, PX, ps["sch"], '"Schedules" [role = Patient]', '"Trips"', size=L)
    pair(s, YX + YW, 1020, 320, PX, ps["cc"], '"Cancel trip" [trip upcoming]', "confirm / release driver\ncapacity; cancel", size=L)
    pair(s, YX + YW, 1040, 340, PX, ps["rd"], '"Rate driver" [trip completed]', "submit / record rating;\ncancel", size=L)
    pair(s, YX + YW, 1060, 360, PX, ps["pd"], '"Preferred driver"', "save / set preference;\nremove / clear; cancel", size=L)
    pair(s, YX + YW, 1080, 380, PX, ps["ar"], '"Add reminder"', "confirm / send event to\nCalendar Service; cancel", size=L)

    s.box(QX, ps["sch"] - 18, QW, 36, "Schedule Form")
    s.poly([(PX + PW, ps["sch"] - 5), (QX, ps["sch"] - 5)])
    s.poly([(QX, ps["sch"] + 5), (PX + PW, ps["sch"] + 5)])
    s.label(QX + QW, 872, '"Add Schedule" / "Edit Schedule"', "end", size=L)
    s.label(QX + QW, 889, "save / store treatment schedule; cancel", "end", size=L)
    s.box(QX, 1000, QW, 36, "Confirm Schedule Deletion")
    s.poly([(QX + QW, 952), (845, 952), (845, 1010), (827, 1010)])
    s.poly([(827, 1022), (858, 1022), (858, 936), (QX + QW, 936)])
    s.label(QX + QW, 946, '"Delete Schedule"', "end", size=L)
    s.label(QX + QW, 966, "confirm / delete schedule; cancel", "end", size=L)

    s.box(QX, ps["ar"] - 22, 92, 44, "Calendar\nService", dashed=True)
    s.poly([(PX + PW, ps["ar"]), (QX - 2, ps["ar"])], dashed=True)
    s.text(QX + 46, ps["ar"] + 38, "external", anchor="middle")

    # --- guarded entry lanes from Login into each role map ---
    s.poly([(390, 66), (390, 86), (30, 86), (30, 440), (DX - 2, 440)])
    s.poly([(410, 66), (410, 120), (38, 120), (38, 760), (AX - 2, 760)])
    s.poly([(430, 66), (430, 154), (46, 154), (46, 1050), (YX - 2, 1050)])
    s.label(56, 69, "[role = Coordinator]", size=L)
    s.label(56, 103, "[role = Driver]", size=L)
    s.label(56, 137, "[role = Patient OR (Caregiver AND linked patients ≤ 1)]", size=L)

    # --- sign out, drawn once for all three entry states ---
    for sy in (470, 790, 1060):
        s.poly([(75, sy), (8, sy)], dashed=True, head=False)
    s.poly([(8, 1060), (8, 58), (328, 58)], dashed=True)
    s.label(14, 206, "sign out / clear session", size=L)

    # --- legend ---
    lx, ly = 52, 1265
    s.top.append(f'<rect x="{lx}" y="{ly}" width="818" height="60" rx="5" fill="#f8f7f3" stroke="#d9d5cb" stroke-width="1.2"/>')
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
    s.label(150, 576, '"Trips" / "Schedules" / "Patients"')

    # --- sign out, drawn once from the Coordinator entry state ---
    s.poly([(330, 340), (14, 340), (14, 88), (138, 88)], dashed=True)
    s.label(30, 318, "sign out (from any function page) / clear session")

    s.text(24, 666, "Dashed arrow: sign out from any function page of any role map returns here.")
    s.text(24, 680, "Login, Create Account, Complete Details, Account Inactive, Select Patient and My Account belong to no role map; every active role reaches My Account.")
    s.text(24, 694, "Coordinator accounts are provisioned manually, so no sign-up path enters the Coordinator map.")
    return s.svg()


# ================================================== Diagram 2: coordinator ===
def d2():
    s = SVG(940, 870)
    DX, DY, DW, DH = 40, 275, 250, 150
    s.dot(14, 350)
    s.poly([(21, 350), (DX - 2, 350)])
    s.box(DX, DY, DW, DH, "Coordinator Trips",
          ["do / display journeys by status and date", "search / filter / sort / update list",
           "select status tile / update list", "select journey / expand detail"],
          uc=["UC-04 (FR-6.1, FR-6.5)"])
    ex = DX + DW
    SX, SW = 520, 170
    RX, RW = 740, 150
    st = {"sched": 60, "pat": 210, "del": 290, "match": 370, "rec": 450, "route": 550, "audit": 630}
    s.box(SX, st["sched"] - 18, SW, 36, "Coordinator Schedules")
    s.box(SX, st["pat"] - 18, SW, 36, "Patients")
    s.box(SX, st["del"] - 18, SW, 36, "Confirm Trip Deletion")
    s.box(SX, st["match"] - 18, SW, 36, "Match a Driver")
    s.box(SX, st["rec"] - 18, SW, 36, "Recovery Options")
    s.box(SX, st["route"] - 18, SW, 36, "Route & Traffic Monitor")
    s.box(SX, st["audit"] - 18, SW, 36, "Audit Log")
    pair(s, ex, 290, 320, SX, st["sched"], '"Schedules"', '"Trips"')
    pair(s, ex, 310, 340, SX, st["pat"], '"Patients"', '"Trips"')
    pair(s, ex, 330, 360, SX, st["del"], '"Delete Trip" [journey unassigned]', "confirm / delete journey,\nretain history; cancel")
    pair(s, ex, 350, 380, SX, st["match"], '"Assign driver" [trip unfilled]', "approve / assign driver; dismiss")
    pair(s, ex, 370, 400, SX, st["rec"], '"Compare options" [trip at-risk]', "approve / apply option; dismiss")
    pair(s, ex, 390, 420, SX, st["route"], '"Routes"', "back")
    pair(s, ex, 410, 440, SX, st["audit"], '"Audit log"', "back")

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

    ey = 352
    s.box(RX, ey, RW, 36, "Escalate Critical", exc=True)
    s.poly([(SX + SW, st["rec"] - 6), (RX, ey + 26)], exc=True)
    s.label(RX + 4, ey + 42, "[no feasible option]", exc=True)
    s.poly([(RX + RW, ey + 18), (915, ey + 18), (915, 24), (DX + 90, 24), (DX + 90, DY - 2)], exc=True)
    s.label(500, 14, "escalate / classify trip Unfilled-Critical", "middle", exc=True)

    uy = 486
    s.box(RX, uy, RW, 36, "Service Unavailable", exc=True)
    s.label(RX + 4, uy - 20, "[service timeout > 5 s]", exc=True)
    s.poly([(SX + SW, st["rec"] + 6), (RX, uy + 10)], exc=True)
    s.poly([(RX, uy + 18), (SX + SW, st["rec"] + 14)], exc=True)
    s.poly([(SX + SW, st["route"] - 6), (RX, uy + 26)], exc=True)
    s.poly([(RX, uy + 34), (SX + SW, st["route"] + 2)], exc=True)
    s.label(RX + 4, uy + 40, "retry / back\n(to originating screen)", exc=True)

    # shared states, drawn here as the targets they are
    s.poly([(70, DY + DH), (70, 748)])
    s.box(20, 750, 130, 36, "Login")
    s.label(78, 600, "sign out / clear session")
    s.box(200, 750, 150, 36, "My Account")
    s.poly([(260, DY + DH), (260, 748)])
    s.poly([(300, 748), (300, 720), (230, 720), (230, DY + DH + 2)])
    s.label(320, 660, '"My Account"')
    s.label(320, 680, '"Trips" / "Schedules" / "Patients"')
    s.text(20, 812, "(shared states, section 2)")

    lx, ly = 510, 760
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
    s = SVG(820, 410)
    s.dot(14, 90)
    s.poly([(21, 90), (38, 90)])
    s.box(40, 12, 340, 180, "Driver Trips",
          ["do / display assigned pickups with route and ETA", "do / display notifications of trip changes",
           "toggle availability slot / update availability", "select trip / expand detail"],
          uc=["UC-06 Manage Driver Availability (FR-3.1)", "UC-10 Notify Affected Users (FR-6.2)"])
    s.box(590, 40, 210, 44, "Confirm Unavailability", sub="UC-07 (FR-3.2, FR-5.1)")
    pair(s, 380, 62, 0, 590, 62, '"Report unavailable"', "confirm / flag trip At-Risk; cancel", lab_right=580)

    # shared states, drawn here as the targets they are
    s.poly([(90, 192), (90, 328)])
    s.box(40, 330, 130, 36, "Login")
    s.label(100, 230, "sign out / clear session")
    s.box(230, 330, 150, 36, "My Account")
    s.poly([(180, 192), (180, 300), (280, 300), (280, 328)])
    s.poly([(330, 328), (330, 280), (240, 280), (240, 194)])
    s.label(260, 224, '"My Account"')
    s.label(260, 246, '"Trips"')
    s.text(40, 392, "(shared states, section 2)")

    s.notebox(420, 180, 380, 148, "Note",
              [["Availability toggling and notifications change content in place,",
                "so they are internal transitions, not separate states."],
               ["Reporting unavailability flags a trip At-Risk, so it is confirmed",
                "before the action is applied."],
               ["No driver assignment exists in the current slice, so this screen",
                "renders an honest unavailable state rather than invented trips."]])
    return s.svg()


# ========================================== Diagram 4: patient & caregiver ===
def d4():
    s = SVG(960, 780)
    YX, YY, YW, YH = 40, 230, 300, 185
    s.dot(14, 322)
    s.poly([(21, 322), (38, 322)])
    s.box(YX, YY, YW, YH, "Patient Trips",
          ["do / display next pickup, status and review flag", "do / display owned journeys, filtered and paged",
           "do / display notifications of trip changes", "confirm trip / record confirmation",
           "select journey / expand detail"],
          uc=["UC-09 Track Active Trip, UC-10 Notify", "Affected Users, UC-11 View Upcoming Pickup"])
    ex = YX + YW
    SX, SW = 560, 180
    RX, RW = 780, 180
    st = {"sch": 80, "cc": 230, "rd": 330, "pd": 430, "ar": 530}
    s.box(SX, st["sch"] - 18, SW, 36, "Patient Schedules")
    s.box(SX, st["cc"] - 22, SW, 44, "Confirm Cancellation", sub="UC-11")
    s.box(SX, st["rd"] - 22, SW, 44, "Rate Driver", sub="UC-12")
    s.box(SX, st["pd"] - 22, SW, 44, "Preferred Driver", sub="UC-12")
    s.box(SX, st["ar"] - 22, SW, 44, "Add Reminder", sub="UC-13")
    pair(s, ex, 250, 430, SX, st["sch"], '"Schedules" [role = Patient]', '"Trips"')
    pair(s, ex, 275, 450, SX, st["cc"], '"Cancel trip" [trip upcoming]', "confirm / release driver\ncapacity; cancel")
    pair(s, ex, 300, 470, SX, st["rd"], '"Rate driver" [trip completed]', "submit / record rating; cancel")
    pair(s, ex, 325, 490, SX, st["pd"], '"Preferred driver"', "save / set preference;\nremove / clear; cancel")
    pair(s, ex, 350, 510, SX, st["ar"], '"Add reminder"', "confirm / send event to\nCalendar Service; cancel")

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
    s.poly([(90, YY + YH), (90, 618)])
    s.box(40, 620, 130, 36, "Login")
    s.label(100, 500, "sign out / clear session")
    s.box(230, 620, 150, 36, "My Account")
    s.poly([(180, YY + YH), (180, 590), (280, 590), (280, 618)])
    s.poly([(330, 618), (330, 560), (240, 560), (240, YY + YH + 2)])
    s.label(260, 470, '"My Account"')
    s.label(260, 492, '"Trips" / "Schedules"')
    s.text(40, 684, "(shared states, section 2)")

    s.notebox(420, 600, 520, 160, "Notes",
              [["Calendar Service is outside the system boundary, so it is drawn as an external",
                "participant, not a state. Only Add Reminder belongs to this system."],
               ["Rating and preferred-driver management are separated: the first is post-trip",
                "feedback, the second a standing preference with a different lifetime."],
               ["Caregivers share this map, scoped to their linked Patient. Schedules is guarded to",
                "Patient: caregiver linking (UC-02.1) is not implemented, so no scope exists yet."],
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
    ("My Account", '"Schedules"', "[role = Patient]", "—", "Patient Schedules"),
    ("My Account", '"Patients"', "[role = Coordinator]", "—", "Patients"),
    ("My Account", "edit", "[role = Patient]", "unlock owned details", "My Account (self)"),
    ("My Account", "save", "[role = Patient, version current]", "update owned profile", "My Account (self)"),
    ("My Account", "cancel", "[role = Patient]", "discard changes", "My Account (self)"),
    ("My Account", "—", "[role = Patient, owned profile missing]", "—", "Complete Details"),
    ("Coordinator Trips / Patients", '"Schedules"', "—", "—", "Coordinator Schedules"),
    ("Coordinator Schedules / Patients", '"Trips"', "—", "—", "Coordinator Trips"),
    ("Coordinator Trips / Coordinator Schedules", '"Patients"', "—", "—", "Patients"),
    ("Coordinator Schedules", '"Generate Trips"', "[schedule version current, sessions in supported range]", "—", "Generate Trips"),
    ("Generate Trips", "confirm", "[future range ≤ 90 days]", "create unfilled outbound and return journeys", "Coordinator Schedules"),
    ("Generate Trips", "cancel", "—", "—", "Coordinator Schedules"),
    ("Coordinator Trips", '"Delete Trip"', "[journey unassigned]", "—", "Confirm Trip Deletion"),
    ("Confirm Trip Deletion", "confirm", "[version current]", "delete journey, retain history", "Coordinator Trips"),
    ("Confirm Trip Deletion", "cancel", "—", "—", "Coordinator Trips"),
    ("Coordinator Trips", '"Assign driver"', "[trip unfilled]", "—", "Match a Driver"),
    ("Match a Driver", "approve", "—", "assign driver", "Coordinator Trips"),
    ("Match a Driver", "dismiss", "—", "—", "Coordinator Trips"),
    ("Coordinator Trips", '"Compare options"', "[trip at-risk]", "—", "Recovery Options"),
    ("Recovery Options", "approve", "—", "apply recovery option", "Coordinator Trips"),
    ("Recovery Options", "dismiss", "—", "—", "Coordinator Trips"),
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
    ("Driver Trips", '"Report unavailable"', "—", "—", "Confirm Unavailability"),
    ("Confirm Unavailability", "confirm", "—", "flag trip At-Risk", "Driver Trips"),
    ("Confirm Unavailability", "cancel", "—", "—", "Driver Trips"),
    ("Patient Trips", '"Schedules"', "[role = Patient]", "—", "Patient Schedules"),
    ("Patient Schedules", '"Trips"', "—", "—", "Patient Trips"),
    ("Patient Schedules", '"Add Schedule" / "Edit Schedule"', "—", "—", "Schedule Form"),
    ("Schedule Form", "save", "[version current, no overlapping session]", "store treatment schedule", "Patient Schedules"),
    ("Schedule Form", "cancel", "—", "—", "Patient Schedules"),
    ("Schedule Form", '"Delete Schedule"', "[schedule owned]", "—", "Confirm Schedule Deletion"),
    ("Confirm Schedule Deletion", "confirm", "—", "delete schedule and linked replacements", "Patient Schedules"),
    ("Confirm Schedule Deletion", "cancel", "—", "—", "Schedule Form"),
    ("Patient Trips", '"Cancel trip"', "[trip upcoming]", "—", "Confirm Cancellation"),
    ("Confirm Cancellation", "confirm", "—", "release driver capacity", "Patient Trips"),
    ("Confirm Cancellation", "cancel", "—", "—", "Patient Trips"),
    ("Patient Trips", '"Rate driver"', "[trip completed AND role = Patient]", "—", "Rate Driver"),
    ("Rate Driver", "submit", "—", "record rating", "Patient Trips"),
    ("Rate Driver", "cancel", "—", "—", "Patient Trips"),
    ("Patient Trips", '"Preferred driver"', "[role = Patient]", "—", "Preferred Driver"),
    ("Preferred Driver", "save", "—", "set preferred driver", "Patient Trips"),
    ("Preferred Driver", "remove", "—", "clear preferred driver", "Patient Trips"),
    ("Preferred Driver", "cancel", "—", "—", "Patient Trips"),
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
<li>Caregivers authenticate through the same Patient entry point using their own account. A Caregiver linked to at most one Patient transitions directly to Patient Trips, under the same guarded transition as a Patient; a Caregiver linked to more than one Patient passes through <b>Select Patient</b> first, since the system cannot determine the scope of the session without that choice. Caregiver linking (UC-02.1) is not implemented, so no Caregiver currently has a linked Patient and Select Patient is not yet reachable.</li>
<li>Signing out from any function page returns to Login rather than to a final state, because the application does not terminate on sign-out. Each authenticated session is bound to a single role (FR-1.3), so only one role map is reachable per session.</li>
<li>Related use case: UC-01 Authenticate User (FR-1.2, FR-1.3, NFR-5.1, NFR-5.2).</li>
</ul>
<div class="sec"><h2>3. Coordinator</h2>
<div class="fig">{d2()}</div></div>
<h3>Design notes</h3>
<ul>
<li>Coordinator Trips carries the UC-04 status categories. Its status tiles, search, filters, sorting, pagination and journey-details dialog all change content within the same screen, so they are internal transitions, not states. The same holds for the Patients and Coordinator Schedules lists.</li>
<li>Guards are shown on the transitions: "Assign driver" is available only on Unfilled trips, "Compare options" only on At-Risk trips, and "Delete Trip" only on a journey with no driver assigned.</li>
<li><b>Coordinator Schedules</b> is read-only: treatment requirements are recorded by the Patient, not the coordinator. <b>Generate Trips</b> replaces the New Trip state of the earlier model. Journeys are derived from a selected treatment schedule over a bounded future range using the treatment times and the standard 15-minute buffer (UC-03), rather than typed in by hand, and generation is idempotent.</li>
<li><b>Patients</b> covers UC-02. Record creation belongs to sign-up and deletion is not permitted, so Patient Details carries neither an "add new" transition nor an archive action; a coordinator may save only Status and Notes.</li>
<li><b>Confirm Trip Deletion</b> is a state for the same reason as the other confirmations: removing a journey cannot be undone from the list. It applies only to an unassigned journey, and the journey's history is retained.</li>
<li><b>Escalate Critical</b> covers FR-5.4. Where the system can generate no feasible recovery option, the trip is classified Unfilled-Critical and escalated for manual intervention rather than silently returning the coordinator to Coordinator Trips. The only exit is <code>escalate</code>, so a trip in this state cannot be left without being escalated.</li>
<li><b>Service Unavailable</b> covers the external-dependency failure implied by FR-4.1, FR-4.2 and NFR-2.1. Where routing or traffic data cannot be retrieved within the five-second bound, the coordinator is shown a recoverable failure state rather than stale or absent data. The same exception applies to Recovery Options, which depends on the same services; retry or back returns the coordinator to whichever of the two screens raised it.</li>
<li>Match a Driver, Recovery Options, Route &amp; Traffic Monitor and Audit Log are designed states with no data path behind them in the current slice; they are modelled here because the use cases require them, not because a screen exists.</li>
<li>The Audit Log serves UC-04 (alternative flow: view audit log) and FR-6.4.</li>
<li>Related use cases: UC-02 Manage Patient Records, UC-03 Manage Treatment and Transport Schedules, UC-04 Monitor Transport Operations, UC-05 Resolve At-Risk Trip, UC-08 Assess Route and ETA.</li>
</ul>
<div class="sec"><h2>4. Driver</h2>
<div class="fig">{d3()}</div></div>
<h3>Design notes</h3>
<ul>
<li>Driver Trips is the Trips function page rendered for a Driver: assigned pickups and weekly availability on one scrolling page, with no tab switch between them.</li>
<li>No driver or vehicle assignment exists in the current slice, so the shipped screen is an honest unavailable state. The internal transitions above remain the designed UC-06 and UC-10 behaviour for when assignment exists.</li>
<li>Toggling an availability slot updates the grid in place and is an internal transition (<code>toggle availability slot / update availability</code>), not a <code>do /</code> activity, because it is triggered by a user event and completes.</li>
<li>Notifications appear in-page, in the shared header panel, so they are modelled as a display activity on this state rather than as a separate screen.</li>
<li><b>Confirm Unavailability</b> is modelled as a state. Reporting unavailability flags the trip At-Risk and requires coordinator intervention (FR-5.1), so it is confirmed before the action is applied rather than being a single irreversible tap.</li>
<li>Related use cases: UC-06 Manage Driver Availability, UC-07 Report Driver Unavailability, UC-10 Notify Affected Users.</li>
</ul>
<div class="sec"><h2>5. Patient &amp; Caregiver</h2>
<div class="fig">{d4()}</div></div>
<h3>Design notes</h3>
<ul>
<li>Patient Trips is a single scrolling page carrying the next pickup — its pickup status, journey date and direction and any review flag — above a date-filtered, paged list of owned journeys. Route addresses and the treatment-derived constraints are in that journey's details dialog, which is an internal transition. There is no separate tracking screen.</li>
<li><b>Patient Schedules</b> carries the guard <code>[role = Patient]</code>: a Caregiver is not routed to it until UC-02.1 linking exists. <b>Schedule Form</b> covers both adding and editing a treatment schedule; the whole-series / one-session scope choice inside it changes the same form, so it is an internal transition. <b>Confirm Schedule Deletion</b> is a state because deleting a series also deletes its linked replacements.</li>
<li>Confirming an upcoming trip acts in place and is an internal transition. Cancelling does not: <b>Confirm Cancellation</b> is a state, because cancelling a dialysis journey releases driver capacity and cannot be undone by the patient. It carries the guard <code>[trip upcoming]</code>, since a completed trip cannot be cancelled.</li>
<li><b>Rate Driver</b> carries the guard <code>[trip completed AND role = Patient]</code>. A trip that has not taken place cannot be rated, and rating is the Patient's own: a Caregiver is not routed to it. <b>Preferred Driver</b> carries <code>[role = Patient]</code> for the same reason.</li>
<li>Rating and preferred-driver management are modelled as two states rather than one. They have different triggers and different lifetimes: one is feedback on a completed trip, the other a standing preference that persists across trips. Both trace to UC-12.</li>
<li><b>Calendar Service</b> is outside the system boundary and is therefore drawn as an external participant, not as a state. The state belonging to this system is <b>Add Reminder</b>; the call to the external service is an action on the confirm transition.</li>
<li>This map is shared by Patients and Caregivers under the login assumption in Section 2. A Caregiver's view is scoped to the linked Patient selected at sign-in, and a Caregiver may confirm or cancel trips on that Patient's behalf.</li>
<li>Related use cases: UC-09 Track Active Trip, UC-10 Notify Affected Users, UC-11 View Upcoming Pickup, UC-12 Manage Driver Feedback and Preference, UC-13 Manage Calendar Reminders.</li>
</ul>
<h2 class="pb">6. Transition Summary</h2>
<p>The transitions below are the formal statement of the model; the diagrams are their visual form. A dash in the Event column denotes a transition triggered by its guard becoming true rather than by a user action.</p>
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
