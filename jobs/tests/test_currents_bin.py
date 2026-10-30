"""currents.bin: the forecast survives encoding to within half a step, and the stored file is read in either form."""

import numpy as np

from lhzn_blue_jobs import fields
from lhzn_blue_jobs.build import Store


def forecast(steps=3, elements=5):
    rng = np.random.default_rng(0)
    u = rng.integers(-230, 231, (steps, elements))
    v = rng.integers(-230, 231, (steps, elements))
    return {
        "schema": 1, "kind": "currents", "label": "model forecast", "units": "cm/s", "t0": "2026-10-30T00:00:00Z",
        "step": 7200, "steps": steps, "elements": elements, "generated_at": "2026-10-30T01:00:00Z",
        "u": u.tolist(), "v": v.tolist(),
    }


def test_round_trip_within_half_a_step():
    data = forecast()
    back = fields.decode_currents(fields.encode_currents(data))
    assert back["u"].shape == back["v"].shape == (3, 5)
    assert np.abs(back["u"] - np.array(data["u"])).max() <= fields.CURRENT_STEP_CMS / 2
    assert np.abs(back["v"] - np.array(data["v"])).max() <= fields.CURRENT_STEP_CMS / 2
    assert {k: back[k] for k in ("t0", "step", "steps", "elements", "label")} == {k: data[k] for k in ("t0", "step", "steps", "elements", "label")}


def test_east_and_north_stay_apart():
    data = forecast(steps=2, elements=4)
    data["u"] = [[10, 20, 30, 40], [50, 60, 70, 80]]
    data["v"] = [[-10, -20, -30, -40], [-50, -60, -70, -80]]
    back = fields.decode_currents(fields.encode_currents(data))
    assert back["u"].tolist() == data["u"] and back["v"].tolist() == data["v"]


def test_beyond_the_range_is_held_at_its_end():
    data = forecast(steps=1, elements=2)
    data["u"], data["v"] = [[400, -400]], [[0, 0]]
    back = fields.decode_currents(fields.encode_currents(data))
    assert back["u"].tolist() == [[254.0, -254.0]]


def test_read_prefers_the_binary_and_falls_back_to_json(tmp_path):
    store = Store(str(tmp_path))
    assert fields.read_currents(store) is None
    old = forecast()
    (tmp_path / "v1/fields").mkdir(parents=True)
    (tmp_path / "v1/fields/currents.json").write_text(__import__("json").dumps(old))
    assert fields.read_currents(store)["u"] == old["u"]  # from before currents.bin
    store.write_bytes("v1/fields/currents.bin", fields.encode_currents(old), max_age=3600)
    assert isinstance(fields.read_currents(store)["u"], np.ndarray)
