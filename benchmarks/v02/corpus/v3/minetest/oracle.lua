local marker_by_name = {}
local offsets_by_name = {}
local function audit(name, event)
    local player = minetest.get_player_by_name(name)
    if not player then return end
    local p = player:get_pos()
    local rows, count, target_count, target_minimap_count = {}, 0, 0, 0
    for _, obj in ipairs(minetest.get_objects_inside_radius(p, 500)) do
        if not obj:is_player() then
            local props = obj:get_properties() or {}
            local ent = obj:get_luaentity()
            local entity_name = ent and ent.name or "unknown"
            if entity_name == "oracle:map_marker" then
                target_count = target_count + 1
                if props.show_on_minimap == true then target_minimap_count = target_minimap_count + 1 end
            end
            if props.show_on_minimap == true then
                count = count + 1
                table.insert(rows, entity_name .. "@" .. minetest.pos_to_string(obj:get_pos()))
            end
        end
    end
    minetest.log("action", "ORACLE_CAPTURE_STATE event=" .. event ..
        " observed_target_entity_count=" .. target_count ..
        " observed_target_minimap_count=" .. target_minimap_count ..
        " observed_minimap_object_count=" .. count .. " observed_inventory=" .. table.concat(rows, ";") ..
        " player_pos=" .. minetest.pos_to_string(p))
end
local function remove_marker(name)
    local marker = marker_by_name[name]
    if marker then marker:remove(); marker_by_name[name] = nil end
end
local function set_marker(name, present)
    local player = minetest.get_player_by_name(name)
    if not player then return false end
    remove_marker(name)
    if present then
        local d = offsets_by_name[name]
        local p = player:get_pos()
        marker_by_name[name] = minetest.add_entity({x=p.x+d[1],y=p.y,z=p.z+d[2]}, "oracle:map_marker")
    end
    return marker_by_name[name] ~= nil
end
minetest.register_entity("oracle:map_marker", {
    initial_properties = {
        physical = false, pointable = false, visual = "sprite",
        textures = {"object_marker_red.png"}, visual_size = {x = 1, y = 1},
        show_on_minimap = true, static_save = false,
    },
})
minetest.register_globalstep(function()
    local p = minetest.get_player_by_name("HeldoutSource")
    if p then p:set_physics_override({gravity = 0}); p:set_velocity({x=0,y=0,z=0}) end
end)
minetest.register_on_joinplayer(function(player)
    local name = player:get_player_name()
    minetest.after(1, function()
        if not player or not player:is_player() then return end
        local x = tonumber(minetest.settings:get("oracle_px") or "")
        local y = tonumber(minetest.settings:get("oracle_py") or "6.5")
        local z = tonumber(minetest.settings:get("oracle_pz") or "")
        if x and z then player:set_pos({x=x,y=y,z=z}) end
        player:set_physics_override({gravity=0}); player:set_velocity({x=0,y=0,z=0})
        offsets_by_name[name] = {
            tonumber(minetest.settings:get("oracle_dx") or "16") or 16,
            tonumber(minetest.settings:get("oracle_dz") or "16") or 16,
        }
        audit(name, "join")
    end)
end)
minetest.register_on_chat_message(function(name, msg)
    local command = msg:match("^(oracle_[a-z]+)$")
    if command == "oracle_on" then set_marker(name, true); audit(name, "on"); return true end
    if command == "oracle_off" then remove_marker(name); audit(name, "off"); return true end
    return false
end)
