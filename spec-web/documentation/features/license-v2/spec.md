# License Management v2

> The license belongs to the ball, not the tablet. The server counts the users each ball has. Any number of tablets can use the same ball. Source: "Updating License Managing Method" (Nov 2026) plus the design discussion collated below.

## Model

- **One license per ball.** The server stores the tier of every ball (the sensor's MAC id); the tablet reads it when it connects. The tier is the raw license integer the backend returns, 1:1 (see `docs/spec/data-auth-identity.md`).
- **Many tablets per ball.** A tablet or phone that connects to a ball uses that ball's license. Nothing is tied to the tablet. This replaces the single registered device per ball.
- **Users are counted on the server**, per ball. What identifies a user to the server is not decided (see Identifying a user).
- **Bundle.** A bundle is several balls sold together, for example Basic Bundle 3. Every ball keeps its own license and its own user count, so Basic Bundle 3 allows up to 3 × 50 = 150 users in total, never more than 50 on any one ball. Free slots on one ball never help another ball.

## Tiers

| Tier | License int | Users per ball |
|---|---|---|
| MyPlayBall | 1 | 1 |
| Basic | 2 | 50 |
| Premium | 3 and above | unlimited |

## Behaviour

### First login of a new user (online)

1. The tablet connects to the ball.
2. The tablet asks the server whether this user may use this ball.
3. If the ball has a free slot, the server adds the user and the count goes up by one.
4. The tablet remembers the user and logs in.

### Returning user (offline)

A user the tablet already knows logs in with no server call. The tablet needs no internet after the first login on that tablet.

### New user with no internet

A user the tablet has never seen cannot be created offline. The tablet asks the server, gets no connection and tells the trainer to go online first. No user is created.

### Known user on a second tablet

The second tablet has never seen the user, so it asks the server once. The server already counts this user on this ball, so no new slot is used and the tablet logs the user in. How the server knows it is the same user depends on the identity decision below.

### The user cap

- MyPlayBall: user 2 is blocked.
- Basic: user 51 is blocked.
- Premium: always room.

A blocked user is not created on the tablet.

### Login decision

```
user enters id
  known on this tablet?      yes -> log in (works offline)
  no -> internet available?  no  -> blocked: connect to the internet first
  yes -> ask the server to add the user to this ball
  ball under its cap?        yes -> log in, user counted
                             no  -> blocked: user limit reached
```

Whether "known" means known on this tablet or known on this tablet for this ball is open (Q9).

## Identifying a user (privacy)

User ids may be national identification numbers. If so they must not be stored on the server or sent to it, whether in the clear, hashed or encrypted. Facts behind that:

- A national id has about nine digits, so a plain hash of it can be reversed by trying every number.
- Encrypting the id, or a JSON with the id and the name, is not anonymisation. Whoever holds the key can read it, so it is still personal data, and adding a name makes a leak worse. Random encryption also stops the server from matching the same user on two tablets, and deterministic encryption needs the key on every tablet.
- Data is anonymous only when nothing derived from the person is sent. A random token made on the tablet, with no relation to the id or the name, meets that.

Options on the table (none is decided; see Q7):

| Option | Server learns | Same person on a second tablet | Cost |
|---|---|---|---|
| Random token per user | nothing about the person | counted again unless linked | simplest and safest |
| Random token plus trainer link | nothing about the person | no extra slot after the trainer links them | one trainer step |
| Token moved by QR code or file | nothing about the person | no extra slot | one transfer step |
| Keyed hash of the id with a per-clinic secret kept on the tablets | a value it cannot reverse | no extra slot, no step | the secret must be shared; a lost secret creates duplicates |

The id and the name stay on the device, encrypted at rest as the app already does. The Recent Users list keeps hiding the id.

## Use cases

| Role | Use case |
|---|---|
| Patient | First login on a ball; log in again with no internet; use the same ball from a second tablet |
| Trainer | Add a user on site; fix a login that was blocked; remove a user to free a slot |
| Clinic owner | Own balls of different tiers; run several tablets on one ball; buy a bundle |
| License server | Hold the tier of each ball; count users per ball; refuse users beyond the cap |

The animated scenes in Visuals show: overview, first login, offline return, new user with no internet, second tablet, user cap and bundle.

## Open

- **Open:** the message the trainer sees when the cap is hit (user 51 on Basic, user 2 on MyPlayBall) and whether it offers a next step (Q1).
- **Open:** whether Guest counts as the one user on MyPlayBall (Q2).
- **Open:** users that already exist on a tablet when it first meets v2: a one-time sync, and what happens when they exceed the cap (Q3).
- **Open:** whether deleting a user frees a slot on the server, and what other tablets keep (Q4).
- **Open:** users created offline can pass the cap before the server counts them (Q5).
- **Open:** what proves it is the same person on two tablets (Q6), and how users are distinguished at all (Q7).
- **Open:** whether user ids are national identification numbers (Q8).
- **Open:** whether "first login to a ball" is per tablet or per tablet and ball (Q9).
- **Open:** whether a bundle is only a sales concept (Q10), and whether a person counts once per ball or once per clinic (Q11).
- **Open:** what happens when a tablet is replaced or the app is reinstalled (Q12), and whether the MyPlayBall user can be replaced (Q13).
- **Open:** what the server may store about a user (Q14) and what reports and the CSV show for the id (Q15).
