# SG LEDDim for Homey Pro (unofficial)

Homey Pro app for **SG LEDDim Smart rotary dimmers**, which use Bluetooth
CSRmesh. The first generation advertises as `@NDxxxx`; the later generations
and LEDDim Smart Pill are supported as a test. Homey talks to them directly
over Bluetooth; no SG gateway is involved.

This app is unofficial and is not affiliated with, endorsed by, or supported by
SG. It does **not** work with SG Smart 3.0, which uses Bluetooth SIG Mesh.
With SG Smart 3.0, use SG Smart Gateway 3.0 to connect the lights to Homey
with Matter.

## Devices

| Driver | Purpose |
| --- | --- |
| `sg_mesh`: LEDDim Smart | One paired device per physical dimmer. The first generation is discovered by scanning for `@NDxxxx` nodes. The later generations (`@MD`, `@SD`, `@GD`, `@SL`, `@GL`, `@MW`, `@SW`, `@GW`, `@MB`, `@SB`, `@SA`, `@GA`) are found by a search that also asks the mesh for names, sent only when the scan shows such a name; experimental. Rename it in Homey after pairing. |
| `sg_pill`: LEDDim Smart Pill | The Pill family (`@MC`, `@SC`, `@GC`, Micro, TW and ON-OFF, not DALI): `onoff` and `dim`, the ON-OFF Pills `onoff`. Found by the same search; experimental. |
| `sg_group`: Group Gen1 | One tile for every first generation dimmer paired in this app. It passes its level on to each dimmer, since these dimmers do not act on a group-addressed message (tested). The tile follows the dimmers' status. |

The dimmer and the group expose `onoff` and `dim`. Other SG products, such as
DIN and plug, are found and logged, but cannot be added yet.

## Setup

1. Add a **LEDDim Smart** device. Every dimmer in range is listed by the name
   it broadcasts, as `LEDDim Smart 1A2B` for `@ND1A2B`. Rename it in
   Homey afterwards.
2. The app uses the CSRmesh **network passphrase** `1234`, which the SG app
   sets unless **Network Isolation** is on there. If it is, turn Network
   Isolation off in the SG app, which sets the passphrase back to `1234`. Then
   all devices must be set up again in the SG app. If you have your home's
   passphrase, you can instead enter it in the settings of every dimmer: they
   all need the same one. A raw 16-byte network key can be entered instead
   under the advanced setting. When Homey hears the dimmers but cannot read
   their status, the dimmers show "Possibly wrong network password. Check
   settings."
3. A LEDDim Smart of a later generation is added the same way, and is listed
   as `LEDDim Smart 3C4D`. A Pill is added as **LEDDim Smart Pill**, and is
   listed as `LEDDim Smart Pill 1A2B`. Their support is experimental; other SG
   devices, such as DIN and plug, cannot be added yet. Tell us in the forum
   thread for the app how it goes. The log from "Show log" in the app
   settings, under Troubleshooting, shows when the lights are used: send it as
   a private message to the developer in the forum, not in the thread.

## How it works

`lib/csrmesh.js` implements the CSRmesh authenticated bearer:
the network passphrase is hashed (`SHA-256` over `passphrase\0MCP`, digest
reversed, first 16 bytes) into an AES-128 key; each packet is
`[seq(3)][source(2)][AES-128-OFB payload][truncated HMAC(8)][0xFF]`.

Every SG command and status carries the home's **location id** (two bytes
set in each dimmer when it is paired), and a dimmer ignores a command
with another one. The app learns it from each dimmer's own status, which the
dimmers send by themselves, and keeps it per dimmer. A learned one changes
only when another comes three times in a row, as from a dimmer paired again in
another home. Until it is known, the dimmer shows a warning, and a command
waits for the dimmer's first status (a few seconds after the app starts).
After 10 s without one, it goes out with the location id the other dimmers
report, if they all report the same one. A command that still cannot go out
after 30 s is dropped.

`lib/MeshBridge.js` owns the single Bluetooth radio. It connects to the
strongest reachable CSRmesh node, writes the packet in two fragments to the
CSRmesh GATT characteristics `…8003` / `…8004`, and disconnects again. Because
a mesh node tends to drop the GATT link after roughly ten seconds, the bridge:

- picks its bridge node by RSSI with 8 dB hysteresis, so it does not flap;
- keeps a *latest-wins* queue per target, so dragging a slider transmits the
  final value rather than every intermediate one;
- refuses to start a packet on a link that is already too old, and recycles it;
- serialises everything, with one shared recovery owner and a 5 s circuit
  breaker, so a failing radio cannot turn into a retry storm.

Status from the wall switch reaches Homey in one of two ways, set by the one
app setting, **Keep dimmers connected**:

- **On** (the default with two or more dimmers): the app holds a link to the
  strongest dimmer, keeps it alive with the SG heartbeat and listens to the
  mesh, so changes show up in Homey within about a second and commands go out
  without a new connection. A dimmer that is held cannot be reached by the SG
  phone app; with two or more dimmers the phone uses another one. A scan once
  an hour keeps the choice of dimmer current.
- **Off** (the default with one dimmer): the app connects for each command and
  holds the link for a minute afterwards, and reads status every five minutes.

Tested on Homey Pro (2026), firmware 13.5.2. Not tested on Homey Self-Hosted Server.

## Development

```sh
homey app validate --level publish
homey app run
```

The manifest is generated by Homey Compose. Edit `.homeycompose/app.json` and
`drivers/*/driver.compose.json`; the root `app.json` is build output.

## How this was made, and why it is public

The code was written with the help of AI and builds on the public protocol
notes below. I cannot claim the parts that make it work.

It is published because the people below published. Every one of them put what
they had found into a public thread instead of keeping it, and that is the only
reason a dimmer from 2017 can be driven from Homey today. Passing it on seemed
like the least I could do.

## Credits

- **[nkaminski](https://github.com/nkaminski/csrmesh)** — reverse-engineered
  CSRmesh itself: the bearer, the key derivation and the crypto that
  [`lib/csrmesh.js`](lib/csrmesh.js) follows. Licensed LGPL-3.0 / GPL-3.0.
- **fromm1990** — identified SG's dimmers as ordinary Qualcomm CSRmesh rather
  than something proprietary, pointed at `csrmesh`, and suggested `1234` as the
  network PIN. [hjemmeautomasjon.no](https://www.hjemmeautomasjon.no/forums/topic/2162-sg-leddim-smart-hack/),
  January 2022.
- **einaros** — independently decoded the protocol in August 2020 and reported
  that these dimmers do not send change notifications, so state has to be
  polled, at the cost of Bluetooth noise. Measurements in this app agree.
- **erlwes** — brought the CSRmesh finding to the Home Assistant community.
  [community.home-assistant.io](https://community.home-assistant.io/t/sg-leddim-bluetooth-dimmers/115168),
  January 2022.
- **mjenssen93**, **erlingba**, **Berg** and others on hjemmeautomasjon.no, who
  kept asking the question from 2017 onwards.

## Licence

LGPL-3.0-or-later. See [`COPYING.LESSER`](COPYING.LESSER) and [`COPYING`](COPYING).

The protocol implementation follows [nkaminski/csrmesh](https://github.com/nkaminski/csrmesh),
which is LGPL-3.0 / GPL-3.0. This app is licensed compatibly with it rather than
claiming terms it has no standing to claim.

