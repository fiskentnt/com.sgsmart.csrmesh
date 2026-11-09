# SG LEDDim for Homey Pro (unofficial)

Homey Pro app for **SG Smart** devices over Bluetooth, without an SG gateway:
the **LEDDim Smart** dimmers and the other SG products that use Bluetooth
CSRmesh, and **LEDDim Smart 3.0**, which uses Bluetooth SIG Mesh. Homey talks
to them directly.

The first generation LEDDim Smart (`@NDxxxx`) and LEDDim Smart 3.0 have been
tested and work. The other products are supported as a test.

This app is unofficial and is not affiliated with, endorsed by, or supported by
SG.

## Devices

| Driver | Products | Capabilities |
| --- | --- | --- |
| `sg_mesh`: LEDDim Smart | The first generation, found by scanning for `@NDxxxx`. The later generations (`@MD`, `@SD`, `@GD`, 400 2-pole `@SL`, `@GL`, TW `@MW`, `@SW`, `@GW`, Master `@MB`, `@SB`, `@SA`, `@GA`), found by a search that also asks the mesh for names, sent only when the scan shows such a name; experimental. | `onoff`, `dim`, signal to Homey and link |
| `sg_group`: Group Gen1 | One tile for the first generation dimmers you tick when you add it, or later under repair. It passes its level on to each dimmer, since these dimmers do not act on a group-addressed message (tested). The tile follows the dimmers' status. | `onoff`, `dim` |
| `sg_pill`: LEDDim Smart Pill | The Pill family (`@MC`, `@SC`, `@GC`, Micro, TW and ON-OFF, not DALI). Found by the same search; experimental. | `onoff` and `dim`, the ON-OFF Pills `onoff` |
| `sg_din`: LEDDim Smart DIN | The DIN dimmers (`@MR`, `@SR`, `@GR`, DIN 1000 `@MM`, `@SM` and TW `@SH`, `@GH`). Found by the same search; experimental. | `onoff`, `dim` |
| `sg_plug`: Smart Plug and Smart Socket | Smart Plug (`@GP`), Smart Socket (`@GB`) and Smart DIN 3600 (`@GM`). Found by the same search; experimental. Flow cards to turn it off in, or on for, a number of minutes, to cancel that countdown, and to check or react when it runs or is done; Homey counts the minutes, not the plug. Smart Plug `@MP` and `@SP` are recalled by SG and are not offered; one added before shows a warning and can still be turned off. | `onoff` |
| `sg_thermostat`: HeatReg Smart | HeatReg Smart (`@MT`, `@ST`). Found by the same search; experimental. Shows the room and floor temperature, the set point, the preset, heating, the open window function, the floor limit and faults. With "Control from Homey" on (the default) Homey can set it on and off, the set point and the preset. | `target_temperature`, `measure_temperature`, the floor temperature, `onoff`, `thermostat_mode`, preset, heating, `measure_power`, `alarm_problem`, open window, floor limit |
| `sg3_dimmer`: LEDDim Smart 3.0 | LEDDim Smart 3.0 (tested) and LEDDim Smart 2-pole 3.0 (experimental). Needs the login with your SG account. | `onoff`, `dim`, signal to Homey and link |

Other SG products, such as Push, Floor and Pill DALI, are found and logged, but
cannot be added yet. Other SG Smart 3.0 products, among them LEDDim Smart DIN
2-pole 3.0, are not supported yet.

## Setup

Set up the devices in the SG app on your phone first: Homey does not add new
devices to the network. Close the SG app on every phone and tablet while you
add devices: the phone and Homey cannot be connected to the same device at the
same time.

1. Add a **LEDDim Smart** device. Every dimmer in range is listed by the name
   it broadcasts, as `LEDDim Smart 1A2B` for `@ND1A2B`, or by the name it has
   in the SG app when you are logged in. Rename it in Homey afterwards.
2. The app uses the CSRmesh **network passphrase** `1234`, which the SG app
   sets unless **Network Isolation** is on there. If it is, log in with your SG
   account in the app settings, and the app fetches your home's passphrase. Or
   turn Network Isolation off in the SG app, which sets the passphrase back to
   `1234`. Then all devices must be set up again in the SG app. If you have
   your home's passphrase, you can instead enter it in the settings of each
   device: they all need the same one. A raw 16-byte network key can be
   entered instead under the advanced setting. When Homey hears the dimmers but
   cannot read their status, the dimmers show "Possibly wrong network
   password. Check the device settings."
3. A LEDDim Smart of a later generation is added the same way, and is listed
   as `LEDDim Smart 3C4D`. A Pill is added as **LEDDim Smart Pill**, a DIN
   dimmer as **LEDDim Smart DIN**, Smart Plug, Smart Socket and Smart DIN 3600
   as **Smart Plug and Smart Socket**, a thermostat as **HeatReg Smart**, and
   LEDDim Smart 3.0 as **LEDDim Smart 3.0**. A device of another product is
   named in the list with the one to choose instead. Their support is
   experimental.
4. Optional, and required for SG Smart 3.0: log in with your SG account in the
   app settings, under **SG account**. The app fetches the network password,
   the names of the devices and, for SG Smart 3.0, the keys of the home. Your
   SG password is not stored. Press **Fetch again** after you have added
   devices in the SG app. **Forget SG account** removes all that was fetched.
5. Tell us in the forum thread for the app how it goes. The log from **Show
   log** in the app settings, under Troubleshooting, shows when the lights are
   used: send it as a private message to the developer in the forum, not in
   the thread.

## Settings

- **SG account**: the login above.
- **Connection**: **Keep SG LEDDim Gen1 connected** and **Keep SG Smart 3.0
  connected**, for faster response (below). With only one device of the kind,
  the SG app on your phone cannot reach it while the setting is on.
- **Signal to Homey**: open a dimmer and check "Link". "Direct" means the
  dimmer has contact with Homey, and the others are reached through it.
- **Which SG devices are supported**: as in the table above.
- **Troubleshooting**: **Detailed logging**, only when the developer asks, and
  **Show log**. Bluetooth addresses and device names are hidden in the log.

## How it works

`lib/csrmesh.js` implements the CSRmesh authenticated bearer:
the network passphrase is hashed (`SHA-256` over `passphrase\0MCP`, digest
reversed, first 16 bytes) into an AES-128 key; each packet is
`[seq(3)][source(2)][AES-128-OFB payload][truncated HMAC(8)][0xFF]`.

Every SG command and status carries the home's **location id** (two bytes
set in each device when it is set up in a home), and a device ignores a
command with another one. A first generation dimmer sends its status by
itself, and the app learns the location id from it, per dimmer. A learned one
changes only when another comes three times in a row, as from a dimmer set up
again in another home. Until it is known, the dimmer shows a warning, and a
command waits for the dimmer's first status (a few seconds after the app
starts). After 10 s without one, it goes out with the location id the other
dimmers report, if they all report the same one. A command that still cannot
go out after 30 s is dropped.

A device after the first generation gets its location id from its answer to
the search, or from its status. The app asks it for its status 15 s after the
start and every 10 minutes after that (a thermostat every 5 minutes), and once
9 s after a command. One that nothing has been heard from for 30 minutes
shows "No contact". That these devices are set and read this way is assumed:
none has been tried with a real device yet.

`lib/MeshBridge.js` owns the single Bluetooth radio for CSRmesh. It connects
to the strongest reachable CSRmesh node, writes the packet to the CSRmesh GATT
characteristics `…8003` / `…8004` (in two fragments when it is longer than
20 bytes), and disconnects again. Because a mesh node tends to drop the GATT
link after roughly ten seconds, the bridge:

- picks its bridge node by RSSI with 8 dB hysteresis, so it does not flap;
- keeps a *latest-wins* queue per target, so dragging a slider transmits the
  final value rather than every intermediate one;
- refuses to start a packet on a link that is already too old, and recycles it;
- serialises everything, with one shared recovery owner and a 5 s circuit
  breaker, so a failing radio cannot turn into a retry storm.

Status from the wall switch reaches Homey in one of two ways, set by
**Keep SG LEDDim Gen1 connected**:

- **On** (the default with two or more first generation dimmers): the app
  holds a link to the strongest dimmer, keeps it alive with the dimmers'
  heartbeat and listens to the mesh, so changes show up in Homey within about
  a second and commands go out without a new connection. A dimmer that is
  held cannot be reached by the SG phone app; with two or more dimmers the
  phone uses another one. A scan once an hour keeps the choice of dimmer
  current.
- **Off** (the default with one dimmer): the app connects for each command and
  holds the link for a minute afterwards, and reads status every five minutes.

The link is held only through a first generation dimmer. In a home without
one, the devices after the first generation are read as above.

LEDDim Smart 3.0 uses Bluetooth SIG Mesh (`lib/sigmesh/`, `lib/sg3/`), with
the network and application keys of the home from the SG account. The app
connects to a 3.0 dimmer as a mesh proxy, sends the level and on and off to
the dimmer, and reads its status back. **Keep SG Smart 3.0 connected** holds
that link, as the setting for the first generation does (on by default with
two or more 3.0 dimmers).

Tested on Homey Pro (2026), firmware 13.5.2. Not tested on Homey Self-Hosted
Server.

## Development

```sh
npm test
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
- Parts of the Bluetooth SIG Mesh code in [`lib/sigmesh/`](lib/sigmesh/) are
  translated from, or follow, **[homey-ble-mesh](https://github.com/shejnowicz/homey-ble-mesh)**
  by shejnowicz and **[ha-sg-smart-mesh](https://github.com/frekarlsen/ha-sg-smart-mesh)**
  by David Simon and Fredrik Karlsen, both under the MIT License. See
  [`lib/sigmesh/LICENSE-MIT`](lib/sigmesh/LICENSE-MIT).
- **[Tabler Icons](https://tabler.io/icons)** (MIT, Paweł Kuna): the icons for
  heating, the open window function and the floor limit. See
  [LICENSE-tabler-icons.txt](LICENSE-tabler-icons.txt).

## Licence

LGPL-3.0-or-later. See [`COPYING.LESSER`](COPYING.LESSER) and [`COPYING`](COPYING).

The protocol implementation follows [nkaminski/csrmesh](https://github.com/nkaminski/csrmesh),
which is LGPL-3.0 / GPL-3.0. This app is licensed compatibly with it rather than
claiming terms it has no standing to claim. Parts of `lib/sigmesh/` are under
the MIT License, with their notices in
[`lib/sigmesh/LICENSE-MIT`](lib/sigmesh/LICENSE-MIT).
