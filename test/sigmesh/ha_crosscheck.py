"""Writes ha-crosscheck.json: reference bytes made by frekarlsen/ha-sg-smart-mesh.

The JS port in lib/sigmesh and lib/sg3 must produce the same bytes for the
same inputs. crosscheck.test.js reads the JSON; this script is only needed to
make it again.

    python3.12 test/sigmesh/ha_crosscheck.py <ha-sg-smart-mesh>/src > test/sigmesh/ha-crosscheck.json

Needs Python 3.10 or newer with the `cryptography` package. Generated from
commit c00c73a. The keys are the public sample keys of the Mesh Profile
specification (§8.1, §8.3), never a real network's.
"""

import json
import sys

sys.path.insert(0, sys.argv[1])

from btmesh import network  # noqa: E402
from btmesh.beacon import build_secure_network_beacon  # noqa: E402
from btmesh.node import DEFAULT_TTL, MeshNode  # noqa: E402
from btmesh.proxy_config import FILTER_ACCEPT_LIST, add_addresses, set_filter_type  # noqa: E402
from btmesh.proxy_pdu import MSG_TYPE_NETWORK_PDU, MSG_TYPE_PROXY_CONFIG, segment  # noqa: E402
from btmesh.sg_smart import parse_sg_status, sg_power_level_set, sg_status_get  # noqa: E402
from btmesh.transport import build_segment_ack, parse_access_lower  # noqa: E402

NET_KEY = bytes.fromhex("7dd7364cd842ad18c17c2b820c84c3d6")
APP_KEY = bytes.fromhex("63964771734fbd76e3b40519d1d94a48")
HOMEY = 0x7FFF
NODE = 0x0003
STATUS_GROUP = 0xCEE8
MTU = 20


def node(src, iv_index, seq):
    sent = []
    return MeshNode(
        netkey=NET_KEY, appkey=APP_KEY, iv_index=iv_index, src_addr=src,
        send_network_pdu=sent.append, seq=seq,
    ), sent


def frames(msg_type, pdus):
    return [[f.hex() for f in segment(msg_type, pdu, MTU)] for pdu in pdus]


def send_case(name, payload, *, src, dst, iv_index, first_seq):
    mesh, sent = node(src, iv_index, first_seq)
    mesh.send_access(dst, payload)
    return {
        "name": name,
        "ivIndex": iv_index,
        "src": src,
        "dst": dst,
        "ttl": DEFAULT_TTL,
        "firstSeq": first_seq,
        "accessPayload": payload.hex(),
        "networkPdus": [p.hex() for p in sent],
        "proxyPdus": frames(MSG_TYPE_NETWORK_PDU, sent),
    }


commands = [
    send_case("level 50", sg_power_level_set(NODE, 50, tid=1, seq=1),
              src=HOMEY, dst=NODE, iv_index=0, first_seq=0x000100),
    send_case("off", sg_power_level_set(NODE, 0, tid=4, seq=1),
              src=HOMEY, dst=NODE, iv_index=0, first_seq=0x000102),
    send_case("on at the last level", sg_power_level_set(NODE, 101, tid=5, seq=1),
              src=HOMEY, dst=NODE, iv_index=0, first_seq=0x000104),
    send_case("status request", sg_status_get(NODE, tid=2, seq=2),
              src=HOMEY, dst=NODE, iv_index=0, first_seq=0x000106),
    send_case("level 30, odd IV Index, SeqZero wraps", sg_power_level_set(NODE, 30, tid=7, seq=7),
              src=HOMEY, dst=NODE, iv_index=0x12345677, first_seq=0x001FFF),
]

# What a node sends back: a segmented 0x09 reply to Homey, and an unsegmented
# 0x03 broadcast to the status group. Homey acknowledges the segmented one.
OP_STATUS = bytes.fromhex("f0e80e")
reply_params = bytes.fromhex("09017373 7fff 0135 1900".replace(" ", ""))
broadcast_params = bytes.fromhex("03a684ffff011e19")
received = []
for name, params, dst, first_seq in (
    ("reply, on 53 %", reply_params, HOMEY, 0x000050),
    ("broadcast, on 30 %", broadcast_params, STATUS_GROUP, 0x000052),
):
    case = send_case(name, OP_STATUS + params, src=NODE, dst=dst, iv_index=0, first_seq=first_seq)
    status = parse_sg_status(params)
    case["status"] = {"kind": status.kind, "on": status.on, "level": status.level}
    lower = parse_access_lower(network.decode(network.NetworkContext(NET_KEY, 0), bytes.fromhex(case["networkPdus"][0])).transport_pdu)
    if hasattr(lower, "seq_zero"):
        ack_seq = 0x000200
        ack = network.encode(
            network.NetworkContext(NET_KEY, 0), ctl=True, ttl=DEFAULT_TTL, seq=ack_seq, src=HOMEY, dst=NODE,
            transport_pdu=build_segment_ack(seq_zero=lower.seq_zero, block_ack=(1 << (lower.seg_n + 1)) - 1),
        )
        case["ack"] = {"seq": ack_seq, "seqZero": lower.seq_zero, "networkPdu": ack.hex()}
    received.append(case)

# The proxy filter on a new link: accept list, then Homey and the status group.
mesh, _ = node(HOMEY, 0, 0x000300)
filter_messages = [set_filter_type(FILTER_ACCEPT_LIST), add_addresses([HOMEY, STATUS_GROUP])]
filter_pdus = [mesh.build_proxy_config_pdu(m) for m in filter_messages]
proxy_filter = {
    "ivIndex": 0,
    "src": HOMEY,
    "firstSeq": 0x000300,
    "messages": [m.hex() for m in filter_messages],
    "networkPdus": [p.hex() for p in filter_pdus],
    "proxyPdus": frames(MSG_TYPE_PROXY_CONFIG, filter_pdus),
}

beacons = [
    {"ivIndex": iv, "ivUpdate": upd, "beacon": build_secure_network_beacon(NET_KEY, iv_index=iv, iv_update=upd).hex()}
    for iv, upd in ((0, False), (0x12345678, True))
]

json.dump({
    "source": "frekarlsen/ha-sg-smart-mesh c00c73a, test/sigmesh/ha_crosscheck.py",
    "netKey": NET_KEY.hex(),
    "appKey": APP_KEY.hex(),
    "mtu": MTU,
    "commands": commands,
    "received": received,
    "proxyFilter": proxy_filter,
    "beacons": beacons,
}, sys.stdout, indent=2)
print()
