# together.py: "Together" videos for the Animal Antics worker: 2-4 animals in one funny video.
#
# The user picks 2-4 animals (their own videos or photos, links, free library clips or a painted surprise animal)
# and a scene card (Drive, Dance, Fight ...). The worker puts them all into ONE new start picture with a free
# multi-picture AI (the composer), shows it on the job card for a quick check, and then makes the video like any
# other: Wan 2.2 parts chained from that picture, captions, music, meme effects, pet voice, Follow me ending
# ("one scene"). When the picture can't be made, each animal gets its own short AI moment, cut on the beat ("one
# by one"). When the free AI time is used up, or the user wants it free, the real clips go side by side, into a
# VS screen, a grid or quick cuts on the worker's own CPU ("the free looks"); that one clip then goes through the
# same join as every video, so captions, music and effects work the same.
#
# Here: the scenes, the prompts, the composer, the free looks (ffmpeg) and the job's steps. The steps use the
# worker's storage, engines and join through `w` (worker.py passes itself in), so this file never imports
# worker.py and can be tested on its own.

import colorsys
import json
import math
import os
import random
import re
import shutil
import subprocess
import time
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

import beats
import ideas

MIN_CAST, MAX_CAST = 2, 4
LOOKS = ('ai', 'turns', 'free')  # one scene (one AI picture that moves) | one by one | the scene's free look
FREE_LOOKS = ('split', 'vs', 'grid', 'cuts')  # side by side | VS screen | grid (video call, band) | quick cuts
SOURCES = ('upload', 'link', 'library', 'surprise')  # where an animal comes from
VIDEO_MB = 60  # the biggest video file an animal may send whole (else the page sends its frames)
REAL_BEFORE, REAL_SECONDS = 2.0, 6.0  # the real clip kept per animal: from 2 s before its moment, 6 s long
CHECK_SECONDS = 120  # the picture check: it starts moving by itself after this long
COMPOSE_SIDE = 640  # each animal's picture shrinks to this long side for the composer (enough for the look)
OUT_W, OUT_H, FPS = 720, 1280, 30
STILL_ZOOM = 0.12  # a photo (or a painted animal) in a free look slowly zooms in this much
NAME_TAG = (int(OUT_H * 0.62), 64)  # the creator's name tag in the worker's join (its top, about how tall), at x 24
HOOK_SECONDS = 2.0  # the Real -> AI opening's real seconds (the join keeps 1.2-2 s of it, ending on a beat)
TURN_SECONDS = (2.5, 5.0)  # one by one: each animal's part lasts this long (at least, at most)
FONT = os.environ.get('ANTICS_FONT', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf')
PLACES = ('on the left', 'on the right', 'in the middle', 'at the back')
ORDINALS = ('first', 'second', 'third', 'fourth')
LETTERS = 'ABCD'
DARK = '0x161310'

# The camera look of each scene: words for the composed picture and for the video parts.
STYLES = {
    'phone': {'image': 'candid amateur smartphone photo, vertical, natural lighting',
              'video': 'Realistic handheld smartphone video'},
    'dashcam': {'image': 'wide-angle dashboard camera still from inside a car, vertical, slight fisheye, daylight '
                         'through the windows',
                'video': 'Static wide-angle dashcam footage from inside the car'},
    'sports': {'image': 'TV sports broadcast frame, vertical, bright arena lights, crowd blurred in the dark background',
               'video': 'TV sports broadcast footage'},
    'concert': {'image': 'smartphone photo from the crowd at a small club concert, vertical, coloured stage lights '
                         'and haze',
                'video': 'Handheld smartphone concert footage from the crowd'},
    'wedding': {'image': 'wedding videographer still, vertical, soft golden-hour light, shallow depth of field',
                'video': 'Smooth wedding videographer footage'},
    'runway': {'image': 'fashion-week runway photo from the end of the catwalk, vertical, bright runway lights',
               'video': 'Fashion-week runway footage, static camera at the end of the catwalk'},
}
FOLLOW = ', carrying straight on from the picture without a cut'
TURN_LOOK = 'Realistic video, same camera angle and same place as the picture'  # one by one: the pet's own place
GUARD_2 = ('Natural, physically believable movement; the {A} stays on the left and the {B} stays on the right, and '
           'both keep exactly the same look, fur and faces.')
GUARD_MORE = ('Natural, physically believable movement; every animal stays in its own place and keeps exactly the '
              'same look, fur and face.')
PLAYFUL = 'It is playful cartoon boxing with soft gloves: nobody gets hurt.'  # in every Fight prompt (TikTok rules)
KEEP = "Keep each animal's exact fur, colours, markings and face."
STARE = 'All of them slowly turn their heads and stare straight into the camera with deadpan faces.'
# The plain picture the composer gets a second try with, when it refused the scene once.
PLAIN = ('In a cozy living room in natural daylight, all the animals sit upright side by side on a sofa like '
         'people, looking at the camera, full bodies visible.')
OWN = ('In a fitting everyday place, the animals are about to do this together: {story}. They are upright like '
       'people, side by side and facing the camera, full bodies visible.')

# The scene cards. Prompts (setting, parts) come from the tests in the research (wfD/video/multi_scenes.json):
# {A} = the first animal (left), {B} the second (right), {C} the third (middle), {D} the fourth (back), filled with
# colour + kind words, never pet names. Per scene: animals (fewest, most), the camera style, the picture's setting
# and what a 3rd/4th animal is doing in it (extra), the 3 parts of the story and what a 3rd/4th animal does in them
# (others), order (the funniest parts first: a 1- or 2-part video takes those, in story order), the meme moments of
# each part [(kind, fraction of the clip)], captions ({A}/{B}: the pet's name, else "the dog"), the auto songs, the
# free look and its labels and line, and the prop-free solo action of each role for one by one (image-to-video
# can't add a guitar that isn't in the picture), with its moments.
SCENES = {
    'drive': {
        'card': 'Drive', 'emoji': '🚗', 'title': 'Road trip', 'animals': (2, 4), 'style': 'dashcam',
        'setting': "Inside a car on a sunny day, the {A} sits upright in the driver's seat on the left of the picture "
                   'with both front paws on the steering wheel and the {B} sits upright in the passenger seat on the '
                   'right, both wearing seat belts, trees and houses visible through the windows.',
        'extra': ['The {C} sits in the back seat between them, peeking forward.',
                  'The {D} sits in the back seat next to it, looking out of the window.'],
        'parts': ['The {A} on the left steers calmly with one paw and bobs its head to the music, while the {B} on the '
                  'right leans toward the open window, ears and fur flapping in the wind. Trees and houses rush past.',
                  'The {A} on the left suddenly yanks the steering wheel hard to one side; both animals sway sideways '
                  'together and the {B} on the right braces against the dashboard with both front paws, eyes wide.',
                  'The {B} on the right slowly turns its head and gives the {A} a long judging stare, while the {A} '
                  'keeps both paws on the wheel and glances innocently at the camera.'],
        'others': ['The {C} in the back seat bobs its head along.', 'The {D} in the back seat stares out of the window.'],
        'order': [1, 2, 0], 'moments': [[], [('bump', 0.4)], [('stare', 0.5)]],
        'captions': ['POV: you let {A} drive', 'Road trip with my bestie', 'Who gave {A} a license 💀'],
        'songs': ['Life of Riley', 'Carefree', 'Pixel Peeker Polka - faster'],
        'free': 'split', 'labels': ['Driver', 'Passenger', 'Back seat', 'Back seat'],
        'free_line': 'Road trip with my bestie',
        'solo': ['pretends to drive, holding an invisible steering wheel with both front paws, swaying left and right '
                 'and bobbing its head to the music',
                 'leans to one side like out of a car window, ears flapping in the wind, then gives the camera a long '
                 'judging stare',
                 'bounces up and down excitedly like on a bumpy back seat, then looks straight into the camera'],
        'solo_moments': [[('bump', 0.6)], [('stare', 0.7)], [('stare', 0.75)]],
    },
    'dance': {
        'card': 'Dance', 'emoji': '💃', 'title': 'Dance together', 'animals': (2, 4), 'style': 'phone',
        'setting': 'In a cozy living room with a sofa and string lights, the {A} on the left and the {B} on the right '
                   'stand upright on their hind legs side by side like two people, front paws raised in a dance pose, '
                   'facing the camera, full bodies visible from head to feet.',
        'extra': ['The {C} stands between them in the same pose.',
                  'The {D} stands behind them in the middle in the same pose.'],
        'parts': ['The {A} on the left and the {B} on the right dance in perfect sync, bouncing on their hind legs, '
                  'swinging their hips and waving their front paws in the air to the beat.',
                  'The {A} on the left spins around once and strikes a confident pose; the {B} on the right tries the '
                  'same spin, wobbles and almost falls over.',
                  'Both freeze mid-move, slowly turn their heads and stare straight into the camera, then burst back '
                  'into the dance even harder.'],
        # With 3-4 animals the first part is a group dance with one standout gag.
        'group_part': 'All the animals dance the same TikTok dance side by side in perfect sync, bouncing and waving '
                      'their front paws, while the {A} on the far left is always one beat late.',
        'others': ['The {C} in the middle dances along.', 'The {D} at the back dances along.'],
        'order': [0, 2, 1], 'moments': [[], [('spin', 0.35), ('fail', 0.75)], [('freeze', 0.3)]],
        'captions': ['When the beat drops 💀', 'Besties learning the trend', "One of them didn't practice"],
        'songs': ['Monkeys Spinning Monkeys', 'Kool Kats', 'Fluffing a Duck'],
        'free': 'cuts', 'labels': None, 'free_line': 'Besties learning the trend',
        'solo': ['dances hip-hop on its hind legs, bouncing to the beat, swinging its hips and waving its front paws '
                 'in the air',
                 'tries a fancy spin on its hind legs, wobbles, almost falls over, then keeps dancing like nothing '
                 'happened'],
        'solo_moments': [[('spin', 0.5)], [('fail', 0.55)]],
    },
    'fight': {
        'card': 'Fight', 'emoji': '🥊', 'title': 'Boxing match', 'animals': (2, 4), 'style': 'sports', 'playful': True,
        'setting': 'In a boxing ring under bright lights, the {A} on the left and the {B} on the right stand upright '
                   'on their hind legs facing each other like boxers, both wearing small red boxing gloves and shiny '
                   'boxing shorts, gloves raised, full bodies visible.',
        'extra': ['The {C} cheers at the ringside in the middle, behind the ropes.', 'The {D} cheers at the ringside too.'],
        'parts': ['The {A} on the left and the {B} on the right bounce on their hind legs and circle with their gloves '
                  'up; the {A} throws two quick playful jabs at the air and the {B} leans back to dodge.',
                  'The {B} on the right winds up a huge slow-motion swing, misses completely and spins around in a '
                  'full circle, while the {A} on the left ducks and stares at the camera in disbelief.',
                  'The {A} on the left gently taps the {B} with one soft glove; the {B} flops dramatically onto the mat '
                  'like a fake injury, then peeks at the camera with one eye open.'],
        'others': ['The {C} at the ringside cheers and waves its paws.', 'The {D} at the ringside covers its eyes.'],
        'order': [2, 1, 0], 'moments': [[('hit', 0.5)], [('spin', 0.5)], [('fail', 0.55)]],
        'captions': ['The rematch nobody asked for 🥊', 'He flopped harder than a footballer', 'Undefeated (he cheated)'],
        'songs': ['Hall of the Mountain King', 'Run Amok', 'Scheming Weasel faster'],
        'free': 'vs', 'labels': ['RED', 'BLUE', 'FAN', 'FAN'], 'free_line': 'Who wins? 🥊',
        'solo': ['stands up on its hind legs like a boxer and shadow boxes toward the camera, throwing playful jabs at '
                 'the air and bouncing on its feet',
                 'dodges an invisible punch in slow motion, spins around once and does a dramatic fake flop, then '
                 'peeks at the camera with one eye open',
                 'cheers wildly like a fan at the ringside, waving both front paws in the air'],
        'solo_moments': [[('hit', 0.5)], [('fail', 0.6)], []],
    },
    'band': {
        'card': 'Band', 'emoji': '🎸', 'title': 'Rock band', 'animals': (2, 4), 'style': 'concert',
        'setting': 'On a small club stage, the {A} on the left stands upright playing an electric guitar on a strap and '
                   'the {B} on the right sits upright behind a drum kit holding two drumsticks.',
        'extra': ['The {C} stands upright in the middle singing into a microphone on a stand.',
                  'The {D} plays a small keyboard at the back.'],
        'parts': ['The {A} on the left strums the electric guitar and headbangs, while the {B} on the right hits the '
                  'drums with both drumsticks, cymbals shaking. Coloured stage lights sweep across the band.',
                  'The {A} on the left drops to its knees for a wild guitar solo with its head thrown back, while the '
                  '{B} on the right twirls a drumstick and crashes the cymbal.',
                  'On the final note everyone stops at the same moment; the {A} raises one front paw to the crowd and '
                  'the {B} on the right throws a drumstick into the air as the lights flash.'],
        'others': ['The {C} in the middle sings into the microphone with its eyes closed.',
                   'The {D} at the back plays the keyboard, nodding to the beat.'],
        'order': [0, 2, 1], 'moments': [[], [('spin', 0.5)], [('land', 0.6)]],
        'captions': ['Our first gig 🎸', 'The drummer is carrying the band', 'World tour starts tomorrow'],
        'songs': ['Kool Kats', 'Spazzmatica Polka', 'Pixel Peeker Polka - faster'],
        'free': 'grid', 'labels': ['Guitar', 'Drums', 'Vocals', 'Keys'], 'free_line': 'Our first gig 🎸',
        'solo': ['plays a wild air guitar solo on its hind legs, headbanging with its eyes closed',
                 'plays air drums with both front paws very fast, then hits an invisible cymbal',
                 'sings dramatically into an invisible microphone with its eyes closed, swaying side to side',
                 'plays an invisible piano in the air with both front paws, nodding to the beat'],
        'solo_moments': [[('spin', 0.6)], [('hit', 0.7)], [('land', 0.7)], []],
    },
    'dinner': {
        'card': 'Dinner', 'emoji': '🍝', 'title': 'Dinner date', 'animals': (2, 3), 'style': 'phone',
        'setting': 'At a small candle-lit restaurant table, the {A} on the left and the {B} on the right sit upright on '
                   'chairs like two people, white napkins tucked under their chins, a plate of spaghetti in front of '
                   'each, a candle and two glasses on the table, warm cozy light.',
        'extra': ['The {C} sits at the far end of the table in the middle.',
                  'The {D} sits at the next table behind them.'],
        'parts': ['The {A} on the left eats spaghetti politely, slurping one long noodle, while the {B} on the right '
                  "stares hungrily at the {A}'s plate.",
                  'When the {A} on the left turns its head away, the {B} on the right sneakily reaches over with one '
                  "paw and drags the {A}'s plate to its own side of the table.",
                  'The {A} on the left turns back, looks down at the empty spot, then slowly stares at the {B}, who '
                  'freezes with spaghetti hanging from its mouth.'],
        'others': ['The {C} at the far end of the table watches with wide eyes.',
                   'The {D} at the next table pretends not to look.'],
        'order': [1, 2, 0], 'moments': [[], [('freeze', 0.6)], [('stare', 0.4)]],
        'captions': ['Date night went wrong 🍝', "He said he wasn't hungry", 'Never share food with him'],
        'captions_3': ['Third wheel 🍝'],
        'songs': ['Sneaky Snitch', 'Investigations', 'Local Forecast - Elevator'],
        'free': 'split', 'labels': None, 'free_line': 'Date night went wrong 🍝',
        'solo': ['eats an invisible noodle very politely, slurping it with its eyes closed, then licks its lips',
                 'looks left and right sneakily, then grabs something off camera with one paw and hides it behind '
                 'its back',
                 'stares at the camera, completely unimpressed, then sighs'],
        'solo_moments': [[], [('freeze', 0.7)], [('stare', 0.5)]],
    },
    'gym': {
        'card': 'Gym', 'emoji': '💪', 'title': 'Gym bros', 'animals': (2, 3), 'style': 'phone',
        'setting': 'In a bright gym with weight racks and no mirrors, the {A} on the left lies on its back on a weight '
                   'bench holding a barbell above its chest with both front paws, and the {B} on the right stands '
                   'upright behind the bench as the spotter, both wearing tiny sweatbands.',
        'extra': ['The {C} runs on a treadmill in the background.', 'The {D} lifts small dumbbells in the background.'],
        'parts': ['The {A} on the left pushes the barbell up and down slowly, shaking with effort, while the {B} on the '
                  'right shouts encouragement and claps its front paws.',
                  'The {A} on the left gets stuck with the barbell pressing on its chest, eyes wide, while the {B} on '
                  "the right turns to flex its front legs for the camera and doesn't notice.",
                  'The {B} on the right finally lifts the barbell off with one paw like it weighs nothing, and the {A} '
                  'lies there staring at the ceiling, embarrassed.'],
        'others': ['The {C} in the background keeps running on the treadmill.',
                   'The {D} in the background drops its dumbbells.'],
        'order': [1, 2, 0], 'moments': [[], [('freeze', 0.4)], [('stare', 0.6)]],
        'captions': ['My spotter vs me 💪', 'Never skip leg day', 'Gym bros for life'],
        'songs': ['Run Amok', 'Hall of the Mountain King'],
        'free': 'split', 'labels': ['Me', 'My spotter', 'Cardio', 'Cardio'], 'free_line': 'My spotter vs me 💪',
        'solo': ['does squats on its hind legs, shaking with effort, then flexes its front legs like a bodybuilder',
                 'claps its front paws and shouts encouragement at the camera, then flexes proudly',
                 'jogs on the spot on its hind legs, swinging its front paws, completely out of breath'],
        'solo_moments': [[('freeze', 0.7)], [('stare', 0.7)], []],
    },
    'office': {
        'card': 'Office', 'emoji': '💼', 'title': 'Monday meeting', 'animals': (2, 4), 'style': 'phone',
        'setting': 'In a modern office meeting room with glass walls, the {A} on the left stands upright next to a '
                   'whiteboard with a simple bar chart, wearing a tiny suit and tie and pointing at the chart with one '
                   'paw, and the {B} on the right sits upright on a chair at the meeting table in a shirt and tie, an '
                   'open laptop in front of it.',
        'extra': ['The {C} sits at the table too, holding a coffee mug.',
                  'The {D} sits at the end of the table with an open laptop.'],
        'parts': ['The {A} on the left points at the chart and explains very seriously, nodding, while the {B} on the '
                  'right slowly falls asleep, its head drooping lower and lower.',
                  'The {A} on the left slams one paw on the table; the {B} on the right jolts awake and starts typing '
                  'on the laptop super fast, pretending nothing happened.',
                  'The {A} on the left slowly turns to the camera with a completely done face, while the {B} on the '
                  'right gives a big confident nod.'],
        'others': ['The {C} sips from its coffee mug and watches.', 'The {D} stares at its laptop and types.'],
        'order': [1, 2, 0], 'moments': [[], [('bump', 0.3)], [('stare', 0.4)]],
        'captions': ["This meeting could've been an email 💼", 'Me in every Monday meeting', 'The intern vs the boss'],
        'songs': ['Local Forecast - Elevator', 'Wallpaper', 'Investigations'],
        'free': 'grid', 'labels': ['Boss', 'Intern', 'HR', 'IT'], 'free_line': "This meeting could've been an email 💼",
        'solo': ['points at the camera and explains something very seriously, nodding, then slams one paw down',
                 'slowly falls asleep, its head drooping lower and lower, then jolts awake',
                 'sips from an invisible coffee mug and slowly side-eyes the camera',
                 'types super fast on an invisible keyboard, then looks at the camera, very proud'],
        'solo_moments': [[('bump', 0.75)], [('freeze', 0.75)], [('stare', 0.6)], [('stare', 0.8)]],
    },
    'couch': {
        'card': 'Couch', 'emoji': '📺', 'title': 'Movie night', 'animals': (2, 4), 'style': 'phone',
        'setting': 'In a living room in the evening, seen from where the TV stands, the {A} on the left and the {B} on '
                   'the right sit upright side by side on a sofa like two people, a big bowl of popcorn between them, '
                   'the {A} holding a TV remote, their faces lit by the blue glow of the TV.',
        'extra': ['The {C} sits between them on the sofa.', 'The {D} sits on the armrest at the end of the sofa.'],
        'parts': ['The room flickers with TV light. The {A} on the left and the {B} on the right stare at the screen, '
                  'chewing popcorn slowly in sync, eyes wide, completely hooked.',
                  'Something scary happens on TV: both jump at the same moment; the {B} on the right hides its face '
                  "behind a cushion and the {A} on the left grabs the {B}'s paw.",
                  'The {A} on the left slowly turns its head and looks straight into the camera, while the {B} on the '
                  'right peeks out from behind the cushion with one eye.'],
        'others': ['The {C} in the middle hugs the popcorn bowl.', 'The {D} on the armrest peeks through its paws.'],
        'order': [1, 2, 0], 'moments': [[], [('freeze', 0.35)], [('stare', 0.5)]],
        'captions': ['Horror movie night 🍿', 'Who picked this movie', 'We are not scared (we are)'],
        'songs': ['Investigations', 'Hitman', 'Sneaky Snitch'],
        'free': 'split', 'labels': None, 'free_line': 'We are not scared (we are)',
        'solo': ['stares at the camera with wide eyes, chewing slowly, completely hooked on a movie',
                 'jumps in fright, then hides its face behind its front paws and peeks out with one eye',
                 'covers its eyes with its paws, then slowly looks at the camera'],
        'solo_moments': [[('stare', 0.6)], [('freeze', 0.4)], [('stare', 0.7)]],
    },
    'wedding': {
        'card': 'Wedding', 'emoji': '💍', 'title': 'The wedding', 'animals': (2, 3), 'style': 'wedding',
        'setting': 'Under a white flower arch at golden hour, the {A} on the left wears a tiny black tuxedo with a bow '
                   'tie and the {B} on the right wears a white lace veil; both stand upright on their hind legs facing '
                   'each other and holding front paws, rows of white chairs with ribbons behind them.',
        'extra': ['The {C} stands behind them in the middle as the officiant, holding a small book.',
                  'The {D} sits in the first row of chairs.'],
        'parts': ["Slow gentle push-in. The {A} on the left and the {B} on the right hold paws and gaze into each other's "
                  "eyes; the {B}'s veil moves in the breeze as flower petals drift down.",
                  'The {A} on the left leans in for a kiss, but the {B} on the right gives it a quick lick on the nose '
                  'instead, and the {A} blinks in surprise.',
                  'Both turn toward the camera and walk forward together on their hind legs, paw in paw, as flower '
                  'petals fly around them.'],
        'others': ['The {C} behind them reads from its small book and smiles.', 'The {D} in the first row wipes a tear.'],
        'order': [1, 2, 0], 'moments': [[], [('freeze', 0.55)], [('land', 0.5)]],
        'captions': ['They said yes 💍', 'Most wholesome wedding ever', 'Best friends forever, officially'],
        'songs': ['Carefree', 'Life of Riley', 'Wallpaper'],
        'free': 'split', 'labels': None, 'free_line': 'They said yes 💍',
        'solo': ['bows like a gentleman, one paw on its chest, then winks at the camera',
                 'blows a kiss to the camera and spins around once',
                 'nods very seriously like reading the vows, then claps its front paws'],
        'solo_moments': [[('land', 0.7)], [('spin', 0.6)], []],
    },
    'runway': {
        'card': 'Runway', 'emoji': '👠', 'title': 'Fashion week', 'animals': (2, 3), 'style': 'runway',
        'setting': 'On a bright catwalk with photographers blurred on both sides, the {A} walks toward the camera '
                   'upright on its hind legs in front on the left, wearing a designer coat and sunglasses, and the {B} '
                   'follows a few steps behind on the right in a sparkly jacket, full bodies visible.',
        'extra': ['The {C} waits at the far end of the runway in a feather boa.',
                  'The {D} sits in the front row with the photographers.'],
        'parts': ['The {A} in front on the left struts toward the camera with a confident model walk, hips swaying, '
                  'while the {B} behind it on the right copies the walk; camera flashes go off on both sides.',
                  'The {A} stops at the end of the runway, puts one paw on its hip and slowly lowers its sunglasses at '
                  'the camera; behind it on the right, the {B} tries the same pose and nearly trips.',
                  'The {A} turns and struts away with a flick of its tail, while the {B} on the right spins around '
                  'dramatically for the photographers.'],
        'others': ['The {C} at the far end poses in its feather boa.', 'The {D} in the front row claps.'],
        'order': [0, 1, 2], 'moments': [[], [('stare', 0.4), ('fail', 0.8)], [('exit', 0.6)]],
        'captions': ['Serving looks 💅', 'Paris Fashion Week who?', 'Ate and left no crumbs'],
        'songs': ['Kool Kats', 'Hitman', 'Monkeys Spinning Monkeys'],
        'free': 'cuts', 'labels': None, 'free_line': 'Serving looks 💅',
        'solo': ['struts toward the camera on its hind legs like a supermodel, hips swaying, then stops and strikes a '
                 'pose',
                 'copies the model walk, nearly trips, then strikes a pose anyway',
                 'spins around dramatically for the photographers, then flicks its tail'],
        'solo_moments': [[('hit', 0.75)], [('fail', 0.5)], [('spin', 0.6)]],
    },
    'normal': {
        'card': 'Just normal', 'emoji': '🏠', 'title': 'Just normal', 'animals': (2, 4), 'style': 'phone',
        'setting': 'On a living room floor in natural daylight, the {A} on the left and the {B} on the right lie close '
                   'together, both facing the camera.',
        'extra': ['The {C} lies between them.', 'The {D} lies right behind them.'],
        # Part 1 is the prompt of the one GPU test that ran (a black cat and a husky): it worked.
        'parts': ['The {A} on the left suddenly lifts one front paw and slaps the {B} on the nose twice, fast. The {B} '
                  'on the right flinches back in shock with its ears flat, then slowly turns its head and stares at '
                  'the {A} with an offended face, while the {A} looks away innocently.',
                  'The {A} on the left slowly reaches out one paw and boops the {B} on the nose; the {B} on the right '
                  'blinks twice, then sneezes.',
                  "The {B} on the right scoots closer and rests its head on the {A}'s back; the {A} on the left sighs, "
                  'then lets it happen and slowly closes its eyes.'],
        'others': ['The {C} in the middle watches them and blinks slowly.', 'The {D} at the back yawns.'],
        'order': [0, 1, 2], 'moments': [[('hit', 0.4), ('stare', 0.75)], [('freeze', 0.6)], []],
        'captions': ['They pretend to hate each other', 'The disrespect 💀', 'Siblings be like'],
        'songs': ['Quirky Dog', 'Fluffing a Duck', 'Wallpaper'],
        'free': 'split', 'labels': None, 'free_line': 'Siblings be like',
        'solo': ['slowly side-eyes the camera with a deadpan face, then blinks once very slowly',
                 'yawns very widely, then sneezes and looks around embarrassed',
                 'stares at the camera, then slowly looks away like nothing happened'],
        'solo_moments': [[('stare', 0.5)], [('freeze', 0.65)], [('stare', 0.4)]],
    },
    'own': {
        'card': 'Your own', 'emoji': '🎤', 'title': 'Your idea', 'animals': (2, 4), 'style': 'phone',
        'setting': None, 'extra': [], 'parts': [], 'others': ['The {C} in the middle watches and reacts.',
                                                              'The {D} at the back watches and reacts.'],
        'order': [0, 1, 2], 'moments': [[], [], []],
        'captions': ['Besties doing their thing', 'They planned this 💀', 'Nobody: ... Them:'],
        'songs': list(ideas.MUSIC), 'free': 'split', 'labels': None, 'free_line': None,
        'solo': [], 'solo_moments': [],
    },
}
DEFAULT_SCENE = 'normal'
NOTES = {  # the fallback notes shown on the job card
    'turns': "The AI couldn't put them in one picture this time, so each one got its own moment.",
    'pc': 'The free AI time is used up, so your PC made each animal its own part.',
    'offline': 'The free AI is offline right now, so here they are {how}.',
}
HOW = {'split': 'side by side', 'vs': 'in a VS screen', 'grid': 'side by side', 'cuts': 'in quick cuts'}
TAGS = '#funnyanimals #petsoftiktok #aivideo #fyp #viral'
TEXT_OK = set('’‘“”…–—•')


class ComposeError(Exception):
    """No composer could make the picture (each one refused it or is offline)."""


def plain_text(text):
    """Text the video's font can draw (no emoji), like the worker's own captions."""
    return ''.join(ch for ch in text or '' if ord(ch) < 0x2000 or ch in TEXT_OK)


def and_list(items):
    items = list(items)
    return items[0] if len(items) == 1 else ', '.join(items[:-1]) + ' and ' + items[-1]


def scene_of(job_or_id):
    key = job_or_id.get('scene') if isinstance(job_or_id, dict) else job_or_id
    return SCENES.get(key) or SCENES[DEFAULT_SCENE]


def free_look(scene_id, n):
    """The scene's free look for n animals: side by side and the VS screen are for two, a grid for 3-4."""
    look = scene_of(scene_id)['free']
    if look in ('split', 'vs') and n > 2:
        return 'grid'
    if look == 'grid' and n < 3:
        return 'split'
    return look


# ---------- The free clip library ----------
# library.json ships with the worker files; the page reads the same file from its own site. The worker trusts only
# its own copy: a video's labels, licences and credits come from here by id, never from what a page sends.

LIBRARY_FILE = Path(__file__).with_name('library.json')
_library = {'mtime': None, 'clips': {}}


def licence_ok(text):
    """Only licences the videos may use as they are: CC0, public domain, CC BY (never NC, ND or SA)."""
    t = re.sub(r'\s+', ' ', (text or '').strip().lower())
    return bool(t.startswith(('cc0', 'public domain', 'pdm')) or re.fullmatch(r'cc by( \d(\.\d)?)?', t))


def load_library(path=None):
    """The library's clips by id ({} when the file is missing or broken). Read again when the file changes."""
    path = Path(path or LIBRARY_FILE)
    try:
        mtime = path.stat().st_mtime
        if path == LIBRARY_FILE and _library['mtime'] == mtime:
            return _library['clips']
        data = json.loads(path.read_text())
        clips = {str(c['id']): c for c in data.get('clips', []) if isinstance(c, dict) and c.get('id')
                 and licence_ok(c.get('license'))}
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return {}
    if path == LIBRARY_FILE:
        _library.update(mtime=mtime, clips=clips)
    return clips


# ---------- Who is who ----------

def kind_of(entry):
    return re.sub(r'\s+', ' ', re.sub(r'[^a-z ]', '', (entry.get('animal') or '').lower())).strip() or 'animal'


def describe_cast(cast):
    """How the prompts and captions call each animal. Prompts: by kind (+ colour when known) and place, never by
    pet name (the models don't know the pets). Captions and labels: by name, else "the dog".
    Returns per animal {'word': 'black dog', 'kind', 'place', 'who': 'the black dog on the left', 'call', 'title'}."""
    out = []
    for i, c in enumerate(cast):
        kind = kind_of(c)
        color = re.sub(r'[^a-z -]', '', (c.get('color') or '').lower()).strip()
        word = f'{color} {kind}' if color and color not in kind else kind
        name = plain_text(c.get('name') or '').strip()
        out.append({'word': word, 'kind': kind, 'place': PLACES[i], 'who': f'the {word} {PLACES[i]}',
                    'call': name or f'the {kind}', 'title': name or kind.title(), 'name': name})
    return out


def fill(text, desc, key='word'):
    """{A}..{D} in a prompt (or a caption) filled with each animal's words."""
    for i, d in enumerate(desc):
        text = text.replace('{' + LETTERS[i] + '}', d[key])
    return text


def caption_fill(text, desc):
    """A caption with the pets' names (else "the dog"); at the start of the line with a capital."""
    out = fill(text, desc, 'call')
    return out[:1].upper() + out[1:]


COLOURS = {'black', 'white', 'grey', 'gray', 'brown', 'ginger', 'orange', 'golden', 'cream', 'tan', 'fawn', 'red',
           'chocolate', 'silver', 'beige', 'blonde', 'tabby', 'spotted', 'striped', 'calico', 'brindle', 'tricolor',
           'tricolour', 'charcoal', 'tuxedo', 'sandy', 'dark', 'light'}


def colour_words(phrase):
    """'dark charcoal-brown' -> 'dark brown', 'black and white' -> 'black and white', '' when no colour."""
    words = re.findall(r'[a-z]+', (phrase or '').lower())
    found = [x for x in words if x in COLOURS]
    shades = [x for x in found if x in ('dark', 'light')]
    main = [x.replace('gray', 'grey') for x in found if x not in ('dark', 'light')]
    if not main:
        return ''
    if len(main) >= 2 and 'and' in words:
        return f'{main[0]} and {main[-1]}'
    return ' '.join(shades[:1] + [main[-1]])


def colours_from_rewrite(rewrite, n):
    """Colour words per animal from the composer's own rewrite of the prompt (FLUX 3 Image Klein writes e.g. "the
    white cat ... from the second image ... white fur"): {index: 'white'}."""
    text = (rewrite or '').lower()
    out = {}
    marks = [(m.start(), m.end(), ORDINALS.index(m[1])) for m in
             re.finditer(r'from the (first|second|third|fourth) (?:image|picture)', text)]
    for k, (start, end, i) in enumerate(marks):
        if i >= n or i in out:
            continue
        before = re.search(r'the ((?:[a-z-]+ ){0,4}?)[a-z]+ $', text[max(0, start - 60):start])
        word = colour_words(before[1]) if before else ''
        if not word:  # "... preserving the dog's exact ..., dark charcoal-brown fur, short coat ..."
            stop = next((s for s, _, j in marks[k + 1:] if j != i), len(text))
            fur = re.search(r'((?:[a-z]+[ -]){0,2}[a-z]+) (?:fur|coat)\b', text[end:min(stop, end + 400)])
            word = colour_words(fur[1]) if fur else ''
        if word:
            out[i] = word
    return out


def kinds_from_rewrite(rewrite, n):
    """The kind of each animal the composer named in its own rewrite of the prompt ("the white cat from the second
    image"): {index: 'cat'}. For animals nobody named yet ("the animal from the first image")."""
    out = {}
    for m in re.finditer(r'the ((?:[a-z-]+ ){0,4}?)([a-z]+) from the (first|second|third|fourth) (?:image|picture)',
                         (rewrite or '').lower()):
        i, kind = ORDINALS.index(m[3]), ideas.guess_animal(m[2])
        if i < n and i not in out and kind != 'animal':
            out[i] = kind
    return out


def guess_colour(path):
    """A rough colour word for the animal in the middle of a picture (the median colour of its central area), or ''
    when unsure. Only used to tell apart two animals of the same kind before the composer has said more."""
    try:
        img = Image.open(path).convert('RGB')
    except Exception:
        return ''
    img.thumbnail((96, 96))
    a = np.asarray(img, dtype=np.float32)
    h, w = a.shape[:2]
    r, g, b = np.median(a[h // 4:3 * h // 4, w // 4:3 * w // 4].reshape(-1, 3), axis=0) / 255
    hue, sat, val = colorsys.rgb_to_hsv(r, g, b)
    if val < 0.22:
        return 'black'
    if sat < 0.15:
        return 'white' if val > 0.75 else 'grey' if val > 0.35 else ''
    if 0.03 <= hue <= 0.14:  # orange-brown
        return 'golden' if val > 0.65 and sat < 0.6 else 'ginger' if sat > 0.55 else 'brown'
    return ''


def tell_apart(cast, pictures):
    """Two animals of the same kind with no colour words yet: a CPU guess of each one's colour, used only when the
    guesses differ (else the places "on the left" / "on the right" tell them apart). pictures: index -> file."""
    kinds = [kind_of(c) for c in cast]
    for kind in set(kinds):
        same = [i for i, k in enumerate(kinds) if k == kind]
        if len(same) < 2 or any(cast[i].get('color') for i in same):
            continue
        guesses = {i: guess_colour(pictures[i]) for i in same if i in pictures}
        if len(guesses) == len(same) and all(guesses.values()) and len(set(guesses.values())) == len(same):
            for i, word in guesses.items():
                cast[i]['color'] = word


# ---------- The composed picture ----------
# Free multi-picture engines, tried in order. They spend the same daily free GPU time as the Wan clips, so a job
# composes FIRST (while the day's free minutes are untouched) and animates after. Both read "the first image".
# Every call goes through the worker's GPU guard (gpu.py, as w.gpu: one call at a time, the real quota read before
# and after, all AI work stopped if Hugging Face ever bills credits), booked at what the Space books for THESE
# pictures (compose_booking), from each Space's own code (its app.py as it was on 2026-11-03, read with the Hub API)
# and the spaces package's rule (spaces 0.51, the RTX PRO 6000 Blackwell's factors): the @spaces.GPU duration in whole
# seconds, x1.5 on the default size (half a GPU), x2 on 'xlarge'. A Space that sets no size may run on either (one
# with a big model is moved to xlarge), so x2 is counted, as for the worker's ENGINES. Seconds are rounded up.
#   FLUX 3 Image Klein (sha 24df884b, 2026-11-03): /generate runs infer(), whose GPU part is
#     @spaces.GPU(duration=get_duration) with no size:
#       tokens = width * height / 256 + 512 + the sum over the pictures sent of min(w * h, 1024 * 1024) / 256
#       duration = int(min(max(15 + steps * passes * 0.5 * (tokens / 4608) ** 1.5, 20), 300))   (passes: 2 on Base)
#     Its prompt upsampler runs first, outside @spaces.GPU, on the Space's own keys (no ZeroGPU time, nothing
#     billed to the owner). An estimate of 300 or more runs its xlarge function instead (get_duration_xl, at most
#     300 -> 600 booked): never at 720x1280. At 720x1280, 16 steps, with the pictures shrunk to 640 px: two 9:16
#     ones 26 s -> 52; two square ones 30 s -> 60; four square ones 42 s -> 84. request: the worst case, four at
#     its 1024x1024 cap: 90 s -> 180.
#   FLUX.2 klein 4B (sha 0207e56c, 2026-02-09): /infer is @spaces.GPU(duration=85) with no size: 85 -> 170 for any
#     pictures (the prompt upsampling is off).
# If a Space ever books more, its refusal ("Xs requested") or a measured spend raises it for the day (gpu.need()).

COMPOSE_TIMEOUT = 600  # seconds a composer call may take (then it is cancelled: w.gpu.wait_job)

COMPOSE_ENGINES = [
    # FLUX 3 Image Klein (FLUX Kommunity License: outputs may be used commercially by people/companies under US$5M
    # revenue, if each picture is reviewed before posting (the picture check) and labelled as AI). Tested: ~20 s,
    # ~10 s of GPU with pictures shrunk to 640 px; up to 10 pictures. If TENDHA2 ever passes US$5M, swap the order.
    {'id': 'black-forest-labs/flux-3-image-klein', 'name': 'FLUX 3 Image Klein', 'api': '/generate',
     'args': {'mode_choice': 'Distilled (16 steps)', 'width': 720, 'height': 1280, 'num_inference_steps': 16,
              'guidance_scale': 1.0, 'prompt_upsampling': True},
     'booking': 'flux3', 'request': 180},
    # FLUX.2 klein 4B (Apache-2.0): up to 4 pictures (<= 1024 px), books a fixed 85 s of GPU time.
    {'id': 'black-forest-labs/FLUX.2-klein-4B', 'name': 'FLUX.2 klein', 'api': '/infer',
     'args': {'mode_choice': 'Distilled (4 steps)', 'width': 576, 'height': 1024, 'num_inference_steps': 4,
              'guidance_scale': 1.0, 'prompt_upsampling': False},
     'booking': 'fixed', 'duration': 85, 'request': 170},
]
FLUX3_REF_PIXELS = 1024 * 1024  # (FLUX 3 Image Klein's MAX_REF_PIXELS: a picture counts at most this big)


def compose_booking(engine, refs):
    """The ZeroGPU seconds one call to this composer books for these pictures (see COMPOSE_ENGINES); the engine's
    worst case when a picture can't be read."""
    if engine.get('booking') == 'fixed':
        return 2 * math.ceil(engine['duration'])
    if engine.get('booking') != 'flux3':
        return engine['request']
    args = engine['args']
    tokens = int(args['width']) * int(args['height']) / 256 + 512
    for ref in refs:
        try:
            with Image.open(ref) as img:
                pw, ph = img.size
        except Exception:
            return engine['request']
        tokens += min(pw * ph, FLUX3_REF_PIXELS) / 256
    passes = 2 if str(args.get('mode_choice') or '').startswith('Base') else 1
    estimate = 15 + int(args['num_inference_steps']) * passes * 0.5 * (tokens / 4608) ** 1.5
    duration = int(min(max(estimate, 20), 300))
    return 600 if duration >= 300 else 2 * duration  # (300 or more: its xlarge function, at most 300 s, x2)


def shrink_ref(src, out):
    """An animal's picture made small for the composer (COMPOSE_SIDE on its long side)."""
    img = Image.open(src).convert('RGB')
    img.thumbnail((COMPOSE_SIDE, COMPOSE_SIDE), Image.LANCZOS)
    img.save(out, 'JPEG', quality=92)
    return out


def compose_prompt(scene_id, cast, plain=False, story=''):
    """What the composer is asked for: each animal from its image in its place, the scene's setting (or a plain
    sofa picture on the second try), and the keep-the-look line. Pet names never go in."""
    scene, desc, n = scene_of(scene_id), describe_cast(cast), len(cast)
    refs = [f"the {d['word']} from the {ORDINALS[i]} image {d['place']}" for i, d in enumerate(desc)]
    if plain:
        setting = PLAIN
    elif scene['setting']:
        setting = fill(scene['setting'], desc)
    else:  # 'own': the user's own story
        setting = OWN.format(story=story_words(story, desc) or 'have fun')
    extra = [fill(scene['extra'][i - 2], desc) for i in range(2, n) if not plain and i - 2 < len(scene['extra'])]
    guard = [PLAYFUL] if scene.get('playful') and not plain else []
    many = ('both', 'all three', 'all four')[n - 2]
    style = STYLES[scene['style'] if not plain else 'phone']['image']
    return ' '.join([f'Put {and_list(refs)}.', setting, *extra, *guard, KEEP,
                     f'Vertical 9:16 photo, {many} animals large in the frame, faces clearly visible.',
                     f'Photorealistic {style}, no text, no watermark.'])


def compose_picture(refs, prompt, out, w):
    """Puts the animals of 2-4 small pictures (shrink_ref) into ONE new start picture, saved as `out`, with the
    first composer that makes it. Returns {'engine', 'seed', 'rewrite'} (rewrite: the engine's own longer prompt,
    when it writes one). Every call goes through the GPU guard (w.gpu.gpu_call, waited for by w.gpu.wait_job, which
    cancels a call that takes too long), booked at compose_booking() for these pictures: when the free time left
    isn't enough for one engine, the next is tried. Raises w.QuotaError (no free GPU time: the day's free time is
    used up, or the guard stopped AI work) and w.BusyError (every free GPU is taken), like make_clip, and
    ComposeError when every engine refused or is offline.
    w: the worker (its key, GPU guard, error rules, save_picture and log)."""
    from gradio_client import Client, handle_file
    images = [{'image': handle_file(str(r)), 'caption': None} for r in refs]
    last, busy, short = None, False, None
    for engine in COMPOSE_ENGINES:
        def run(engine=engine):  # one ZeroGPU call: only through the GPU guard (wait_job never leaves it running)
            client = Client(engine['id'], token=w.HF_TOKEN, verbose=False)
            return w.gpu.wait_job(client.submit(prompt=prompt, input_images=images, seed=0, randomize_seed=True,
                                                api_name=engine['api'], **engine['args']),
                                  min(COMPOSE_TIMEOUT, w.SPACE_TIMEOUT))
        try:
            result = w.gpu.gpu_call(engine['name'], compose_booking(engine, refs), run)
            picture = result[0]  # a file path (FLUX 3 Image Klein) or {'path': ...} (FLUX.2 klein)
            w.save_picture(Image.open(picture.get('path') if isinstance(picture, dict) else picture), out)
            seed = result[1] if len(result) > 1 and isinstance(result[1], (int, float)) else None
            rewrite = result[2] if len(result) > 2 and isinstance(result[2], str) else ''
            return {'engine': engine['name'], 'seed': None if seed is None else int(seed), 'rewrite': rewrite}
        except w.QuotaError as e:
            if getattr(e, 'guard', False) and getattr(e, 'reason', '') == 'quota':  # (not enough for this one)
                w.log.info('%s', e)
                short = short or e
                continue
            raise
        except (w.gpu.NoKey, w.gpu.KeyRefused):
            raise
        except Exception as e:
            msg = str(e) or type(e).__name__
            if w.is_quota(msg):
                raise w.QuotaError(msg)
            if w.is_auth(msg):
                raise RuntimeError(w.gpu.KEY_REFUSED)
            busy = busy or w.is_busy(msg)
            w.log.warning('%s failed: %s', engine['id'], msg)
            last = msg
    if busy:  # (an engine that fit was busy: soon, not at the reset)
        raise w.BusyError(last)
    if short:
        raise short
    raise ComposeError(f'The free picture engines could not make it ({last})')


# ---------- The parts of the story ----------
# Each part is an idea like the worker's own (caption, story, moments ...) plus its finished prompts: 'prompt' for a
# part that starts from a picture, 'prompt_follow' for one that carries on from the part before. One by one, a part
# also names its animal's own start picture ('picture'), so it starts there instead of carrying on.

def story_words(text, desc, alone=None):
    """The user's own words for a prompt: pet names and "the cat" / "my cat" become the animal with its place ("the
    white cat on the right"), so the model knows who does what; pet names never reach a prompt. alone: one animal's
    part (one by one): names and kinds become just that animal."""
    text = re.sub(r'\s+', ' ', (text or '').strip().rstrip('.!'))
    for i, d in enumerate(desc):
        who = (f"the {alone['word']}" if alone else d['who'])
        if d['name']:
            text = re.sub(rf"\b{re.escape(d['name'])}\b", who, text, flags=re.I)
        if [x['kind'] for x in desc].count(d['kind']) == 1:  # (two cats: "the cat" can't say which one)
            text = re.sub(rf"\b(?:the|my|our|a) {re.escape(d['kind'])}\b(?! (?:on the|in the|at the))", who, text,
                          flags=re.I)
    return text


def _sentence(text):
    text = text.strip()
    if not text:
        return ''
    text = text[0].upper() + text[1:]
    return text if text[-1] in '.!?' else text + '.'


def _has_subject(text, desc):
    words = [d['kind'] for d in desc] + ['they', 'them', 'both', 'all', 'everyone', 'it', 'he', 'she', 'the', 'my']
    return bool(re.match(rf"(?:{'|'.join(map(re.escape, words))})\b", text, re.I))


def scene_prompt(scene, text, desc, follow):
    """A One scene part's prompt: the scene's camera, the part (every animal by kind and place), what a 3rd/4th
    animal does meanwhile, the Fight guard and the keep-in-place guard."""
    look = STYLES[scene['style']]['video'] + (FOLLOW if follow else '')
    n = len(desc)
    others = [fill(scene['others'][i - 2], desc) for i in range(2, n) if i - 2 < len(scene['others'])]
    guard = [PLAYFUL] if scene.get('playful') else []
    keep = fill(GUARD_2, desc) if n == 2 else GUARD_MORE
    return ' '.join([f'{look}.', _sentence(fill(text, desc)), *others, *guard, keep])


def _part(scene, text, desc, caption_t, moments, story_index, custom=False):
    return {'title': 'Together', 'action': fill(text, desc), 'caption_t': caption_t,
            'caption': caption_fill(caption_t, desc) if caption_t else '', 'moments': None if custom else moments,
            'story': True, 'custom': custom, 'twist': '', 'style': None, 'together': True, 'part': story_index,
            'prompt': scene_prompt(scene, text, desc, False), 'prompt_follow': scene_prompt(scene, text, desc, True)}


def pick_caption(scene, n, exclude=()):
    lines = scene['captions'] + (scene.get('captions_3') or [] if n == 3 else [])
    fresh = [c for c in lines if c not in exclude] or lines
    return random.choice(fresh)


def scene_parts(scene_id, cast, count, extra='', plain=False):
    """One scene: `count` parts of the scene's story (its funniest ones for a shorter video, in story order). The
    user's extra idea becomes the middle part. plain: the composer made the plain sofa picture instead of the
    scene's, so the parts are the real-life ones of Just normal (the scene's props aren't in the picture)."""
    scene, desc, n = scene_of(scene_id), describe_cast(cast), len(cast)
    if scene_id == 'own' and not plain:
        return own_parts(cast, count, extra)
    src = SCENES['normal'] if plain else scene
    picks = sorted(src['order'][:count]) if count < len(src['parts']) else list(range(len(src['parts'])))
    out = [story_part(src, p, desc, n, pick_caption(src, n) if k == 0 else '') for k, p in enumerate(picks)]
    if extra:
        k = 1 if count > 1 else 0  # the middle of the story
        words = story_words(extra, desc)
        if not _has_subject(words, desc):
            words = f"The {desc[0]['word']} on the left {words}"
        idea = _part(src, words, desc, out[k]['caption_t'], [], out[k]['part'], custom=True)
        out[k] = idea
    return out


def story_part(src, p, desc, n, caption_t=''):
    """Part p of a scene's story (3-4 animals: the first part is a group action with one standout gag)."""
    text = src['group_part'] if p == 0 and n > 2 and src.get('group_part') else src['parts'][p]
    return _part(src, text, desc, caption_t, src['moments'][p], p)


def more_parts(job, have, wanted):
    """One scene made longer: the parts made stay, and new ones carry on after them, never a part of the story it
    already has (the next ones in the story first, then the funniest left); with the whole story in, everyone
    stares at the camera. Your own: the story carries on even more dramatically, then the stare."""
    out = list(have[:wanted])
    desc, n = describe_cast(job['cast']), len(job['cast'])
    plain = bool((job.get('compose') or {}).get('plain'))
    if job['scene'] == 'own' and not plain:
        scene, story = SCENES['own'], job.get('idea') or ''
        last = (ideas.split_beats(story) or [story or 'have fun together'])[-1]
        while len(out) < wanted:
            i = len(out)
            if i == wanted - 1 and not any(x.get('action') == STARE for x in out):
                out.append(_part(scene, STARE, desc, '', [('stare', 0.4)], i))
            else:
                out.append(_part(scene, f'They carry on even more dramatically: {story_words(last, desc)}', desc, '',
                                 [], i, custom=True))
        return out
    src = SCENES['normal'] if plain else scene_of(job['scene'])
    used = {x.get('part') for x in out}
    after = max((p for p in used if isinstance(p, int)), default=-1)
    left = [p for p in range(len(src['parts'])) if p not in used]
    for p in ([p for p in left if p > after] + [p for p in src['order'] if p in left and p < after])[:wanted - len(out)]:
        out.append(story_part(src, p, desc, n))
    while len(out) < wanted:
        out.append(_part(src, STARE, desc, '', [('stare', 0.4)], None))
    return out


def own_parts(cast, count, story):
    """Your own: the user's words split into parts (ideas.split_beats); a short story ends on everyone's reaction
    stare, the classic punchline (like the worker's own custom_ideas)."""
    scene, desc = SCENES['own'], describe_cast(cast)
    beats_ = ideas.split_beats(story) or [story or 'have fun together']
    if len(beats_) > count:
        beats_ = beats_[:count - 1] + [', then '.join(beats_[count - 1:])]
    caption_t = pick_caption(scene, 0)  # (a one-animal move's caption could miss: "plays chess" is no air guitar)
    out = []
    for i in range(count):
        if i < len(beats_):
            words = story_words(beats_[i], desc)
            if not _has_subject(words, desc):
                words = f"{and_list([d['who'] for d in desc])} {words}"
            out.append(_part(scene, words, desc, caption_t if i == 0 else '', [], i, custom=True))
        elif i == count - 1:
            out.append(_part(scene, STARE, desc, '', [('stare', 0.4)], i))
        else:
            out.append(_part(scene, f'They carry on even more dramatically: {story_words(beats_[-1], desc)}', desc,
                             '', [], i, custom=True))
    return out


def turn_parts(scene_id, cast, count, story=''):
    """One by one: part k shows animal k % n alone, from its own picture, doing its role's prop-free solo action
    (air guitar, shadow boxing toward the camera, a runway strut ...). Each part has its own line: the scene's for
    the first, then "Luna's turn". A small punch-in lands on each cut (meme hits)."""
    scene, desc, n = scene_of(scene_id), describe_cast(cast), len(cast)
    beats_ = ideas.split_beats(story) if scene_id == 'own' else []
    solo = scene if scene['solo'] else SCENES['normal']  # (Your own words with no action in them: everyday moves)
    seen, out = set(), []
    first = pick_caption(scene, n)
    for k in range(count):
        i = k % n
        d = desc[i]
        if beats_:
            action = story_words(beats_[k % len(beats_)], desc, alone=d)
            sentence = action if _has_subject(action, desc) else f"The {d['word']} {action}"
            moments = None
        else:
            role = min(i, len(solo['solo']) - 1)
            sentence, moments = f"The {d['word']} {solo['solo'][role]}", solo['solo_moments'][role]
        guard = f' {PLAYFUL}' if scene.get('playful') else ''
        prompt = (f"{TURN_LOOK}. {_sentence(sentence)}{guard} Natural, physically believable movement, the "
                  f"{d['kind']} keeps exactly the same look, fur and face.")
        if k == 0:
            caption_t = first
        else:
            caption_t = f"{{{LETTERS[i]}}}'s turn" if i not in seen else f'{{{LETTERS[i]}}} again'
        seen.add(i)
        out.append({'title': 'Together', 'action': sentence, 'caption_t': caption_t,
                    'caption': caption_fill(caption_t, desc),
                    'moments': moments, 'story': True, 'custom': moments is None, 'twist': '', 'style': None,
                    'together': True, 'part': k, 'who': i, 'picture': cast[i].get('pic'),
                    'hits': [(0.0, 'cut')] if k else [], 'prompt': prompt, 'prompt_follow': prompt})
    return out


def turn_plan(n, length):
    """One by one: how many parts and how long each is: every animal at least once, about 5 s each, 2.5-5 s."""
    parts = max(n, math.ceil(length / 5 - 1e-6))
    return parts, round(max(TURN_SECONDS[0], min(TURN_SECONDS[1], length / parts)), 3)


def refill_captions(plan, cast, scene_id):
    """New names: the parts' lines filled again (lines the user typed stay as they are)."""
    desc = describe_cast(cast)
    for idea in plan:
        if idea.get('caption_t') and not idea.get('typed'):
            idea['caption'] = caption_fill(idea['caption_t'], desc)


# ---------- Captions, labels and tags ----------

def job_label(scene_id, cast):
    names = [d['title'] for d in describe_cast(cast)]
    who = names[0] if len(names) == 1 else ', '.join(names[:-1]) + ' & ' + names[-1]
    return f"Together: {scene_of(scene_id)['title']} · {who}"[:80]


def uses_ai(job):
    """Whether any part of the video is made by AI (the picture, the animation, a painted animal or the pet voice):
    then TikTok's AI-generated label should be switched on."""
    return (job.get('made_as') in ('ai', 'turns') or any(c.get('from') == 'surprise' for c in job.get('cast') or [])
            or (job.get('voice') or 'off') != 'off')


def shared_uses_ai(job):
    """uses_ai() of the version the video has now (final.mp4: the one played, shared and posted), as finish_video
    kept it (made_with['ai']). While an edit is under way (↻ New picture, another scene, ⇄ Swap places, another
    look) the job's own fields describe the next version (made_as is None until it is planned), but the old one is
    still the video. Before a first version, or for a video made before this was kept: uses_ai() of the job."""
    made = job.get('made_with') or {}
    return bool(made['ai']) if job.get('thumb') and 'ai' in made else uses_ai(job)


def credit_lines(job):
    """Each free clip's credit line, once, in the cast's order. A CC BY clip says it was edited (every look crops
    and re-times it, the AI looks also animate it), as its licence asks; CC0 and public domain need no credit,
    but get it too."""
    out = []
    for c in job.get('cast') or []:
        if c.get('credit'):
            free = re.match(r'\s*(cc0|public domain|pdm)', c.get('license') or '', re.I)
            out.append(('Clip: ' if free else 'Clip (edited): ') + c['credit'])
    return list(dict.fromkeys(out))


def caption_credit(job, music_credit='', lines=None):
    """Every credit line a post of this video needs, one per line: the music's, then the free clips' (lines: the
    clips' credit lines the shared version was made with, else the job's now). (The posting plan's plan_caption()
    gives this as the credit, for its own captions and the owner's.)"""
    clips = credit_lines(job) if lines is None else [str(x) for x in lines]
    return '\n'.join(dict.fromkeys(([music_credit] if music_credit else []) + clips))


def tiktok_caption(job, first_text, music_credit=''):
    """The TikTok caption: the first line + tags (#catsanddogs when both are in it; #aivideo when AI made any of
    it), the music's credit and each library clip's credit line."""
    kinds = {kind_of(c) for c in job.get('cast') or []}
    tags = TAGS if uses_ai(job) else TAGS.replace(' #aivideo', '')
    if 'cat' in kinds and 'dog' in kinds:
        tags += ' #catsanddogs'
    return '\n'.join(part for part in (f'{first_text} {tags}'.strip(), caption_credit(job, music_credit)) if part)


def free_labels(scene_id, cast, look):
    """The name pills of a free look: [(text, colour)] per animal. VS: RED / BLUE corners; scenes with roles: the
    role (Boss, Guitar, Driver ...) and the pet's name when it has one; else the name, or the kind."""
    scene, desc = scene_of(scene_id), describe_cast(cast)
    out = []
    for i, d in enumerate(desc):
        if look == 'vs':
            corner = ('RED', 'BLUE')[i] if i < 2 else 'FAN'
            out.append((f"{corner}: {d['title']}", ('red', 'blue', 'dark', 'dark')[i]))
        elif scene.get('labels'):
            role = scene['labels'][min(i, len(scene['labels']) - 1)]
            out.append((f"{role}: {d['name']}" if d['name'] else role, 'dark'))
        else:
            out.append((d['title'], 'dark'))
    return out


def free_line(job):
    """The one line of a free look: the scene's own (Who wins? for the VS screen ...); the other videos of a batch
    get other lines of the scene, so they don't all say the same."""
    scene = scene_of(job)
    if scene.get('free_line') and not job.get('index'):
        return scene['free_line']
    return pick_caption(scene, len(job['cast']), exclude=[scene.get('free_line')])


# ---------- The free looks (CPU only) ----------
# Each look is ONE 720x1280 30 fps clip without sound (layout.mp4); the worker's join then adds the caption, music,
# meme punches and sounds, pet voice, name tag and Follow me ending like for any video. A real clip shorter than the
# video plays forward, then backward (a boomerang); a photo or a painted animal slowly zooms in.

PILL_COLOURS = {'dark': (22, 19, 16, 225), 'red': (214, 40, 40, 235), 'blue': (37, 99, 235, 235)}


def pill(text, path, colour='dark', max_w=320, size=30):
    """A rounded name label, made smaller (then shortened with …) until it is at most max_w pixels wide."""
    text = re.sub(r'\s+', ' ', plain_text(text)).strip()
    probe = ImageDraw.Draw(Image.new('RGBA', (1, 1)))
    while True:
        font = ImageFont.truetype(FONT, size)
        pad = int(size * 0.65)
        width = probe.textlength(text, font=font) + 2 * pad
        if width <= max_w or (size <= 22 and len(text) <= 3):
            break
        if size > 22:
            size -= 2
        else:  # one letter shorter each time, ending in …
            text = text[:-2].rstrip() + '…'
    h = int(size * 1.8)
    img = Image.new('RGBA', (int(width), h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((0, 0, int(width) - 1, h - 1), radius=h // 2, fill=PILL_COLOURS.get(colour, PILL_COLOURS['dark']))
    d.text((width / 2, h / 2), text, font=font, fill=(255, 255, 255), anchor='mm')
    img.save(path)
    return path, img.size


def vs_badge(path, size=280):
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.ellipse((8, 8, size - 8, size - 8), fill=(255, 214, 0, 255), outline=(22, 19, 16, 255), width=12)
    d.text((size / 2, size / 2 + 3), 'VS', font=ImageFont.truetype(FONT, 120), fill=(22, 19, 16), anchor='mm')
    img.save(path)
    return path


def _panel(k, p, w, h, n, tag):
    """Filters that turn input k into a w x h panel of exactly n frames: p['src'] from p['start'] seconds (a clip
    of p['frames'] frames at FPS; forward, then backward when it runs out), or a still with a slow zoom."""
    if p.get('still'):
        return (f'[{k}:v]scale={2 * w}:{2 * h}:force_original_aspect_ratio=increase,crop={2 * w}:{2 * h},setsar=1,'
                f"zoompan=z='1+{STILL_ZOOM}*on/{max(1, n - 1)}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d={n}:"
                f's={w}x{h}:fps={FPS},setsar=1,tpad=stop={FPS}:stop_mode=clone,trim=end_frame={n}[{tag}]')
    total = max(2, int(p['frames']))
    s = max(0, min(int(round(p.get('start', 0) * FPS)), total - 2))
    have = total - s  # frames from the start on
    fit = (f'[{k}:v]fps={FPS},scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},setsar=1,'
           f'trim=start_frame={s},setpts=PTS-STARTPTS')
    end = f'tpad=stop={FPS}:stop_mode=clone,trim=end_frame={n},setpts=PTS-STARTPTS[{tag}]'
    if n <= have:
        return f'{fit},{end}'
    back = n - have  # frames needed after the last one, played backward
    if back <= have - 1:  # one bounce: only the frames it needs are reversed (kept in memory)
        return (f'{fit},split[{tag}f][{tag}r];[{tag}r]trim=start_frame={have - 1 - back}:end_frame={have - 1},'
                f'setpts=PTS-STARTPTS,reverse[{tag}b];[{tag}f][{tag}b]concat=n=2:v=1:a=0,{end}')
    return (f'{fit},split[{tag}f][{tag}r];[{tag}r]trim=end_frame={have - 1},setpts=PTS-STARTPTS,reverse,'
            f'trim=end_frame={have - 2},setpts=PTS-STARTPTS[{tag}b];[{tag}f][{tag}b]concat=n=2:v=1:a=0,'
            f'loop=loop=-1:size={2 * have - 2}:start=0,{end}')


def _inputs(panels):
    cmd = []
    for p in panels:
        cmd += ['-i', str(p['src'])]
    return cmd


def segments(cuts, seconds, n):
    """Quick cuts: (animal, first frame, frames) for each stretch between cuts, the animals in turn."""
    total = int(round(seconds * FPS))
    marks = [0] + sorted({int(round(c * FPS)) for c in cuts if 0 < c * FPS < total}) + [total]
    return [(j % n, a, b - a) for j, (a, b) in enumerate(zip(marks, marks[1:])) if b > a]


def render_layout(look, panels, seconds, out, labels=(), cuts=()):
    """Renders a free look to `out`: 720x1280, 30 fps, exactly round(seconds * 30) frames, no sound.
    look: 'split' (2 animals stacked, top/bottom), 'vs' (the same in red and blue with the VS badge slamming in),
    'grid' (3: the star on top, two below; 4: 2 x 2) or 'cuts' (full screen, the animals in turn, a cut at each
    time in `cuts`, each animal carrying on where it left off). panels: per animal, in cast order, {'src', 'still',
    'frames', 'start'}. labels: per animal (text, colour) or None, the name pills, placed next to the dividers:
    clear of TikTok's tabs at the top, its buttons on the right and its caption at the bottom.
    Returns {'frames', 'hits', 'pills'}: hits are the moments the look itself makes, for the meme edit ([(fraction
    of the clip, kind)]: the VS slam, a punch on each cut); pills are where the labels went [(x, y, w, h)]."""
    out = Path(out)
    folder = out.parent
    n, frames = len(panels), int(round(seconds * FPS))
    W, H = OUT_W, OUT_H
    cmd = ['ffmpeg', '-v', 'error', '-y'] + _inputs(panels)
    k = n
    parts, pills, hits, boxes = [], [], [], []  # pills: (animal, x, y, widest, from, to: None = the whole video)
    labels = list(labels) + [None] * (n - len(labels))
    if look in ('split', 'vs'):
        if n != 2:
            raise ValueError(f'{look} needs 2 animals, not {n}')
        parts += [_panel(0, panels[0], W, H // 2, frames, 'p0'), _panel(1, panels[1], W, H // 2, frames, 'p1')]
        parts.append('[p0][p1]vstack=inputs=2[s0]')
        last = 's0'
        if look == 'vs':  # red corner on top, blue below, the badge slams in at 0.15 s (2.4x -> 1x in 0.2 s)
            parts.append(f'[s0]drawbox=x=0:y=0:w={W}:h={H // 2}:color=0xff2a2a@0.16:t=fill,'
                         f'drawbox=x=0:y={H // 2}:w={W}:h={H // 2}:color=0x2a6bff@0.16:t=fill[s1]')
            last = 's1'
        parts.append(f'[{last}]drawbox=x=0:y={H // 2 - 4}:w={W}:h=8:color={DARK}:t=fill[lay]')
        last = 'lay'
        if look == 'vs':
            cmd += ['-loop', '1', '-framerate', str(FPS), '-t', f'{seconds + 1:.3f}', '-i', str(vs_badge(folder / 'vs.png'))]
            parts.append(f"[{k}:v]format=rgba,scale=w='trunc(280*max(1,2.4-7*max(0,t-0.15))/2)*2':h=-2:eval=frame[vb];"
                         f"[lay][vb]overlay=x='(W-w)/2':y='(H-h)/2':enable='gte(t,0.15)':eval=frame[vsd]")
            k, last = k + 1, 'vsd'
            hits.append((0.15 / seconds, 'hit'))
            # just above the badge, and below it under the creator's name tag (which sits right under the badge)
            spots = [(24, H // 2 - 200, 400), (24, sum(NAME_TAG) + 10, 400)]
        else:
            spots = [(24, H // 2 - 78, 330), (24, H // 2 + 24, 330)]
        pills += [(i, *spots[i], 0.0, None) for i in range(2)]
    elif look == 'grid':
        if n == 3:  # the star on top (720x640), the others below (360x640 each)
            parts += [_panel(0, panels[0], W, H // 2, frames, 'p0'), _panel(1, panels[1], W // 2, H // 2, frames, 'p1'),
                      _panel(2, panels[2], W // 2, H // 2, frames, 'p2')]
            parts.append('[p1][p2]hstack=inputs=2[bot];[p0][bot]vstack=inputs=2,'
                         f'drawbox=x=0:y={H // 2 - 4}:w={W}:h=8:color={DARK}:t=fill,'
                         f'drawbox=x={W // 2 - 4}:y={H // 2}:w=8:h={H // 2}:color={DARK}:t=fill[lay]')
            spots = [(24, H // 2 - 78, 330), (20, H // 2 + 24, 316), (W // 2 + 20, H // 2 + 24, 236)]
        elif n == 4:  # 2 x 2, each cell 9:16 like a phone video (a video call)
            parts += [_panel(i, panels[i], W // 2, H // 2, frames, f'p{i}') for i in range(4)]
            parts.append('[p0][p1][p2][p3]xstack=inputs=4:layout=0_0|w0_0|0_h0|w0_h0,'
                         f'drawbox=x=0:y={H // 2 - 4}:w={W}:h=8:color={DARK}:t=fill,'
                         f'drawbox=x={W // 2 - 4}:y=0:w=8:h={H}:color={DARK}:t=fill[lay]')
            spots = [(20, H // 2 - 78, 316), (W // 2 + 20, H // 2 - 78, 236), (20, H // 2 + 24, 316),
                     (W // 2 + 20, H // 2 + 24, 236)]
        else:
            raise ValueError(f'grid needs 3 or 4 animals, not {n}')
        last = 'lay'
        pills += [(i, *spots[i], 0.0, None) for i in range(n)]
    elif look == 'cuts':
        segs = segments(cuts, seconds, n)
        need = {}
        for i, _, count in segs:
            need[i] = need.get(i, 0) + count
        used = {i: 0 for i in need}
        streams = {}
        for i, count in need.items():  # one stream per animal, as long as all its turns together
            parts.append(_panel(i, panels[i], W, H, count, f'a{i}'))
            uses = [j for j, s in enumerate(segs) if s[0] == i]
            if len(uses) > 1:
                parts.append(f'[a{i}]split={len(uses)}' + ''.join(f'[a{i}_{j}]' for j in uses))
                streams.update({j: f'a{i}_{j}' for j in uses})
            else:
                streams[uses[0]] = f'a{i}'
        for j, (i, first, count) in enumerate(segs):
            parts.append(f'[{streams[j]}]trim=start_frame={used[i]}:end_frame={used[i] + count},'
                         f'setpts=PTS-STARTPTS[g{j}]')
            used[i] += count
            pills.append((i, 24, 560, 420, first / FPS, (first + count) / FPS))
            if j:  # a punch on every cut, a whoosh on every other one (the meme edit adds them)
                hits.append((first / frames, 'swish' if j % 2 else 'cut'))
        parts.append(''.join(f'[g{j}]' for j in range(len(segs))) + f'concat=n={len(segs)}:v=1:a=0[lay]')
        last = 'lay'
    else:
        raise ValueError(f'no look {look!r}')
    for m, (i, x, y, widest, t0, t1) in enumerate(pills):
        if not labels[i] or not labels[i][0]:
            continue
        text, colour = labels[i]
        png, size = pill(text, folder / f'pill_{m}.png', colour, max_w=widest)
        boxes.append((x, y, *size))
        cmd += ['-i', str(png)]
        when = f":enable='between(t,{t0:.3f},{t1 - 0.5 / FPS:.3f})'" if t1 is not None else ''
        parts.append(f'[{last}][{k}:v]overlay={x}:{y}{when}[l{m}]')
        last, k = f'l{m}', k + 1
    parts.append(f'[{last}]format=yuv420p[out]')
    part = out.with_name(out.stem + '.part.mp4')
    cmd += ['-filter_complex', ';'.join(parts), '-map', '[out]', '-frames:v', str(frames), '-r', str(FPS), '-an',
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
            str(part)]
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    os.replace(part, out)
    return {'frames': frames, 'hits': sorted(hits), 'pills': boxes}


def _bar_phase(info):
    """Which of every 4 beats is the bar's downbeat: the strongest one (the same rule as meme.beat_hits)."""
    grid = np.asarray(info['beats'], dtype=float)
    rms, fps = np.asarray(info['rms']), beats.FPS

    def level(a, b):
        i, j = int(max(0, a) * fps), int(max(0, b) * fps)
        return float(rms[i:j].mean()) if j > i and i < len(rms) else 0.0

    accent = np.array([level(b, b + 0.12) for b in grid])
    return max(range(4), key=lambda p: accent[p::4].mean())


def downbeats(info, start, seconds):
    """The song's bar downbeats inside a video that starts at `start` in the song (video seconds)."""
    grid = np.asarray(info['beats'], dtype=float)
    return [float(b) - start for b in grid[_bar_phase(info)::4] if 0 <= float(b) - start <= seconds]


def plan_cuts(info, start, seconds, n=2, shortest=1.0):
    """Quick cuts: where the video cuts to the next animal, on the song's bar downbeats (two bars apart when the bars
    are short, half bars when they are long), every 2 s without a song. No stretch shorter than `shortest`. Every
    one of the n animals gets a turn when there is room: then the cuts come on half bars, or on every beat, and at
    last stretches may be a little shorter."""
    def spaced(marks, least):
        cuts = []
        for t in sorted(marks):
            if t >= least and seconds - t >= least and (not cuts or t - cuts[-1] >= least):
                cuts.append(round(float(t), 4))
        return cuts

    if not info or len(info.get('beats', [])) < 8:
        options = [np.arange(2.0, seconds, 2.0), [seconds * k / n for k in range(1, n)]]
    else:
        bar = 4 * 60.0 / float(info.get('bpm') or 120)
        grid = np.asarray(info['beats'], dtype=float) - start
        phase = _bar_phase(info)
        downs, halves = grid[phase::4], grid[phase % 2::2]
        options = [downs[::2] if bar < 1.4 else halves if bar > 3.2 else downs, halves, grid]
    cuts = []
    for least in (shortest, 0.75 * shortest):
        for marks in options:
            cuts = spaced(marks, least)
            if len(cuts) + 1 >= n:
                return cuts
    return cuts


def snap_turns(clips, spans, shown, speed, info, start, clip_info):
    """One by one: each plain cut moves onto the beat just before it (beats.snap_cuts: a part gets at most one beat
    shorter, so a slow song's beat is always in reach), on a whole frame of its clip. start: where the song is when
    the first part begins. Returns the new spans and seconds shown."""
    if not info or len(info.get('beats', [])) < 2:
        return spans, shown
    beat = float(np.median(np.diff(np.asarray(info['beats'], dtype=float))))
    want = beats.snap_cuts(info, start, shown, max_trim=max(0.6, beat + 0.02))
    new_spans, new_shown = [], []
    for clip, (first, end), d, was in zip(clips, spans, want, shown):
        _, _, frames, fps = clip_info(clip)
        end = frames if end is None else end
        if abs(d - was) > 1e-6:
            end = max(first + 1, min(end, first + int(round(d * fps * speed))))
        new_spans.append((first, end))
        new_shown.append((end - first) / fps / speed)
    return new_spans, new_shown


# ---------- The job's steps ----------
# w is the worker (worker.py passes itself): its jobs, storage, engines, join and HTTP errors.

FILE_PIC = re.compile(r'p(\d)\.(?:jpe?g|png|webp)', re.I)
FILE_VIDEO = re.compile(r'v(\d)\.(mp4|mov|m4v|webm|mkv|ogv)', re.I)
FILE_FRAME = re.compile(r'f(\d)_(\d{1,4})\.jpe?g', re.I)
STAGES = {'split': 'Putting them side by side…', 'vs': 'Making the VS screen…', 'grid': 'Putting them in a grid…',
          'cuts': 'Cutting them on the beat…'}


def count_frames(path):
    out = subprocess.run(['ffprobe', '-v', 'error', '-count_packets', '-select_streams', 'v:0', '-show_entries',
                          'stream=nb_read_packets', '-of', 'csv=p=0', str(path)], check=True, capture_output=True,
                         text=True).stdout
    return int(out.strip().split(',')[0] or 0)


def _real_clip(cmd, out, log):
    part = out.with_name(out.stem + '.part.mp4')
    try:
        subprocess.run(cmd + ['-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p',
                              '-movflags', '+faststart', str(part)], check=True, stdout=subprocess.DEVNULL,
                       stderr=subprocess.PIPE, timeout=300)
        frames = count_frames(part)
        if frames < FPS // 2:
            raise RuntimeError(f'only {frames} frames')
        os.replace(part, out)
        return frames
    except Exception as e:  # a real clip must never cost a video: that animal is then a still
        log.warning('no real clip %s: %s', out.name, getattr(e, 'stderr', None) or e)
        part.unlink(missing_ok=True)
        return 0


SMALL = "fps=30,scale='if(lte(iw,ih),min(720,iw),-2)':'if(lte(iw,ih),-2,min(720,ih))',format=yuv420p"


def cut_real(source, at, out, log):
    """An animal's real clip (real_i.mp4): 6 s of its video from 2 s before its picked moment `at`, 30 fps, at most
    720 px on the short side, no sound. Returns {'frames', 'at': the moment's seconds in the clip} or None."""
    start = max(0.0, float(at or 0) - REAL_BEFORE)
    frames = _real_clip(['ffmpeg', '-v', 'error', '-y', '-ss', f'{start:.3f}', '-i', str(source), '-t',
                         f'{REAL_SECONDS:.3f}', '-vf', SMALL], out, log)
    return {'frames': frames, 'at': round(min(float(at or 0) - start, frames / FPS), 3)} if frames else None


def real_from_frames(paths, rate, out, at, log):
    """An animal's real clip from the frames the page sent (when its video was too big to send whole), in order.
    at: the picked moment's seconds into these frames (else 2 s in, or a third of the way)."""
    work = out.with_name(out.stem + '_frames')
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir(parents=True)
    try:
        for k, path in enumerate(paths):  # numbered without gaps, for the image sequence reader
            os.replace(path, work / f'f_{k:04d}.jpg')
        frames = _real_clip(['ffmpeg', '-v', 'error', '-y', '-framerate', f'{rate:.3f}', '-start_number', '0', '-i',
                             str(work / 'f_%04d.jpg'), '-vf', SMALL], out, log)
    finally:
        shutil.rmtree(work, ignore_errors=True)
    if not frames:
        return None
    seconds = frames / FPS
    when = at if at is not None else min(REAL_BEFORE, seconds / 3)
    return {'frames': frames, 'at': round(max(0.0, min(float(when), seconds)), 3)}


def set_real(c, real, i):
    if real:
        c.update(real=f'real_{i}.mp4', real_frames=real['frames'], real_s=round(real['frames'] / FPS, 3),
                 real_at=real['at'])
    else:
        c.update(real=None, real_frames=0, real_s=0.0, real_at=0.0)


def _number(value, default):
    try:
        return float(value) if value is not None and value != '' else default
    except (TypeError, ValueError):
        return default


def read_cast(text, w):
    """The animals the page sent (JSON, 2-4 entries, in order), checked and cleaned, or a 400 with a plain reason.
    Labels, licences and credits of library clips come from the worker's own library.json, by id."""
    bad = w.HTTPException
    try:
        raw = json.loads(text or '')
    except ValueError:
        raise bad(400, 'Could not read the animals. Pick them again.')
    if not isinstance(raw, list) or not all(isinstance(e, dict) for e in raw):
        raise bad(400, 'Could not read the animals. Pick them again.')
    if len(raw) < MIN_CAST:
        raise bad(400, 'Add one more animal (Together needs 2-4)')
    if len(raw) > MAX_CAST:
        raise bad(400, f'Up to {MAX_CAST} animals in one video')
    library, cast = load_library(), []
    for i, e in enumerate(raw):
        src = e.get('from')
        if src not in SOURCES:
            raise bad(400, f'Animal {i + 1}: pick a video, a link, a free clip or a surprise animal')
        c = {'from': src, 'animal': w.clean_animal(str(e.get('animal') or '')),
             'name': w.clean_name(str(e.get('name') or ''))[:20], 'color': '', 'pic': None, 'label': '', 'credit': ''}
        set_real(c, None, i)
        if src == 'link':
            url = str(e.get('url') or '').strip()
            if not re.match(r'^https?://\S+$', url):
                raise bad(400, f"Animal {i + 1}: that link doesn't look right")
            c.update(url=url[:500], label='Link')
        elif src == 'library':
            clip = library.get(str(e.get('id') or ''))
            if not clip:
                raise bad(400, f"Animal {i + 1}: that free clip isn't in the list any more. Pick another one.")
            c.update(id=str(clip['id']), label='Free clip', credit=str(clip.get('credit') or '')[:300],
                     license=str(clip.get('license') or ''), page=str(clip.get('page') or ''),
                     animal=c['animal'] or w.clean_animal(str(clip.get('animal') or '')),
                     at=max(0.0, _number(e.get('at'), _number(clip.get('start'), 0.0))))
        elif src == 'upload':
            c.update(label='Your video', at=max(0.0, _number(e.get('at'), 0.0)))
        else:  # a painted animal (chosen now, so every video of the batch gets the same one)
            c.update(label='Painted', animal=c['animal'] or random.choice(ideas.SURPRISE_ANIMALS))
        if e.get('real_at') is not None:  # (frames: where the picked moment is in them)
            c['sent_at'] = max(0.0, _number(e['real_at'], 0.0))
        cast.append(c)
    return cast


def sort_files(uploads, n):
    """The cast's files by animal: p{i}.jpg (its picture), v{i}.mp4 (its whole video) or f{i}_{nnn}.jpg (frames)."""
    out = {i: {'pic': None, 'video': None, 'frames': {}} for i in range(n)}
    for upload in uploads or []:
        name = Path(upload.filename or '').name
        for pattern, key in ((FILE_PIC, 'pic'), (FILE_VIDEO, 'video'), (FILE_FRAME, 'frames')):
            m = pattern.fullmatch(name)
            if m and int(m[1]) < n:
                if key == 'frames':
                    out[int(m[1])]['frames'][int(m[2])] = upload
                else:
                    out[int(m[1])][key] = upload
    return out


def keep_upload(w, i, c, files, folder, real_fps):
    """An uploaded animal (or a library clip, which the page fetched and sends the same way): its picture and its
    real clip, kept in the first video's folder. A 400 when the picture is missing or the video is too big."""
    bad = w.HTTPException
    if not files['pic']:
        what = 'free clip' if c['from'] == 'library' else 'video'
        raise bad(400, f'Animal {i + 1} has no picture. Pick its {what} again.')
    try:
        img = Image.open(files['pic'].file)
        img.load()
    except Exception:
        raise bad(400, f"Animal {i + 1}'s picture could not be opened")
    w.save_picture(img, folder / f'animal_{i}.jpg')
    c['pic'] = f'animal_{i}.jpg'
    real = None
    if files['video']:
        path = folder / f'upload_{i}{Path(files["video"].filename).suffix.lower()}'
        try:
            size = 0
            with open(path, 'wb') as f:
                while chunk := files['video'].file.read(1 << 20):
                    size += len(chunk)
                    if size > VIDEO_MB * 1024 * 1024:
                        raise bad(400, f"Animal {i + 1}'s video is over {VIDEO_MB} MB. Send a shorter one.")
                    f.write(chunk)
            real = cut_real(path, c.get('at', 0), folder / f'real_{i}.mp4', w.log)
        finally:
            path.unlink(missing_ok=True)
    elif files['frames']:
        paths = []
        for k in sorted(files['frames'])[:int(REAL_SECONDS * 60)]:
            path = folder / f'frame_{i}_{k:04d}.jpg'
            with open(path, 'wb') as f:
                shutil.copyfileobj(files['frames'][k].file, f)
            paths.append(path)
        real = real_from_frames(paths, real_fps, folder / f'real_{i}.mp4', c.get('sent_at'), w.log)
        for path in paths:
            path.unlink(missing_ok=True)
    c.pop('sent_at', None)  # (a photo: no real clip)
    set_real(c, real, i)


def cast_files(cast):
    return [name for c in cast for name in (c.get('pic'), c.get('real')) if name]


def scene_song(scene_id):
    return random.choice([s for s in scene_of(scene_id)['songs'] if s in ideas.MUSIC] or list(ideas.MUSIC))


def build_jobs(w, who, count, settings, form):
    """New Together videos (POST /jobs with mode 'together'): `count` videos of the same animals (each its own
    picture and take). form: scene, look, cast (JSON), cast_files, real_fps, clips, song, badge, endcard. The
    uploads' pictures and real clips are kept now and copied to every video; links and painted animals are
    fetched by the job itself. A 400 with a plain reason when something is missing."""
    cast = read_cast(form['cast'], w)
    scene_id = form['scene'] if form['scene'] in SCENES else DEFAULT_SCENE
    if scene_id == 'own' and not settings['idea']:
        raise w.HTTPException(400, 'Describe what they do together')
    files = sort_files(form['cast_files'], len(cast))
    for i, c in enumerate(cast):  # every picture is there before anything is kept
        if c['from'] in ('upload', 'library') and not files[i]['pic']:
            what = 'free clip' if c['from'] == 'library' else 'video'
            raise w.HTTPException(400, f'Animal {i + 1} has no picture. Pick its {what} again.')
    look = form['look'] if form['look'] in LOOKS else 'ai'
    settings = dict(settings, music='funny' if settings['music'] == 'mine' else settings['music'])  # (one sound each)
    if settings['music'] == 'funny' or not settings.get('track'):
        settings['track'] = settings['track'] if settings['music'] == 'track' else scene_song(scene_id)
    part_seconds = settings['seconds']
    clips = max(1, min(w.MAX_CLIPS, int(form['clips'] or 1)))
    now = time.time()
    group = w.secrets.token_hex(4) if count > 1 else None
    made = [dict(settings, id=f"{time.strftime('%Y%m%d-%H%M%S')}-{w.secrets.token_hex(3)}", created=now, index=k,
                 batch=count, group=group, status='queued', stage='In line…', progress=0, error='', wanted=clips,
                 made=0, clips_done=[], chain={}, redos=0, owner=who['id'],
                 owner_name='' if who is w.OWNER else who['name'], kind='together', scene=scene_id, look=look,
                 made_as=None, length=clips * part_seconds, part_seconds=part_seconds, picture_check=False, note='',
                 inputs=None, ideas=[], draft=settings['draft'] and look == 'ai')
            for k in range(count)]
    folder = w.job_dir(made[0]['id'])
    shared, flags = w.shared_files(who, folder, settings, form['song'], form['badge'], form['endcard'])
    real_fps = max(10.0, min(60.0, float(form['real_fps'] or 30)))
    try:
        for i, c in enumerate(cast):
            if c['from'] in ('upload', 'library'):
                keep_upload(w, i, c, files[i], folder, real_fps)
    except BaseException:
        shutil.rmtree(folder, ignore_errors=True)
        raise
    names = cast_files(cast)
    for job in made:
        job.update(flags, cast=json.loads(json.dumps(cast)), animal=cast[0]['animal'] or 'animal',
                   label=job_label(scene_id, cast), hook_frames=hook_planned(cast))
        if job is not made[0]:
            for name in shared + names:
                shutil.copy(folder / name, w.job_dir(job['id']) / name)
    with w.jobs_lock:
        for job in made:
            w.jobs[job['id']] = job
    w.save_many([(job, shared + names) for job in made])
    return made


def hook_planned(cast):
    """The Real -> AI opening's frames when any animal has a real clip (it is rendered when it is first used)."""
    return int(round(HOOK_SECONDS * FPS)) if any(c.get('real') for c in cast) else None


def same_cast(a, b):
    keys = ('from', 'url', 'id', 'animal')
    return len(a) == len(b) and all(all(x.get(k) == y.get(k) for k in keys) for x, y in zip(a, b))


def fetch_link(job, w, folder, i, c):
    """A linked animal: the video downloaded once (yt-dlp, else another public route), its sharpest moment as the
    picture and 6 s around it as the real clip; a site that only shows a picture: that picture, no real clip."""
    sub = folder / f'link_{i}'
    shutil.rmtree(sub, ignore_errors=True)
    sub.mkdir(parents=True)
    ask = {'id': job['id'], 'url': c['url'], 'music': 'none'}
    pic, real, text = folder / f'animal_{i}.jpg', None, ''
    try:
        try:
            try:
                source, label, text = w.download_link(ask, sub)
            except Exception as e:
                found = w.fallback_video(ask, sub)
                if not found:
                    raise
                w.log.info('%s: animal %d: yt-dlp failed (%s), got the video another way', job['id'], i + 1, e)
                source, label, text = found
            sampled = w.sample_frames(source, sub)
            _, at = w.pick_start(sampled, 0, 1, pic)
            real = cut_real(source, at, folder / f'real_{i}.mp4', w.log)
        except Exception as e:
            w.log.warning('%s: animal %d: download failed (%s), trying the public pictures', job['id'], i + 1, e)
            names, label, text = w.link_pictures(ask, sub, 1)
            if not names:
                raise RuntimeError(f"Animal {i + 1}'s link couldn't be downloaded. Save that video to your phone and "
                                   'upload it instead.') from e
            shutil.move(str(sub / names[0]), str(pic))
    finally:
        shutil.rmtree(sub, ignore_errors=True)
    guess = ideas.guess_animal(text)
    c.update(pic=pic.name, label=(label or 'Link')[:80], animal=c['animal'] or ('' if guess == 'animal' else guess))
    set_real(c, real, i)


def paint(w, folder, i, c):
    """A surprise animal, painted (Pollinations, else FLUX on Hugging Face: the worker's own surprise_picture)."""
    prompt = (f"Photorealistic phone photo of a {c['animal']} standing upright, full body, plain living room, "
              'no text')
    w.surprise_picture(prompt, folder / f'animal_{i}.jpg')
    c.update(pic=f'animal_{i}.jpg', label='Painted')


def gather(job, w):
    """Gets the animals that aren't in yet (links, painted animals), once for every video of the batch: the files go
    to the batch's other videos with the same animals too. The ones got are saved even when a later one fails (out
    of free time, a link that fails): the job only fetches what is still missing when it tries again."""
    cast = job['cast']
    todo = [i for i, c in enumerate(cast) if not c.get('pic')]
    if not todo:
        return
    folder = w.job_dir(job['id'])
    # (the batch's other videos with the same animals, found before this one's animals are filled in)
    others = [o for o in list(w.jobs.values()) if o is not job and job.get('group') and o.get('group') == job['group']
              and o.get('kind') == 'together' and same_cast(o['cast'], cast)]
    got = []
    try:
        for i in todo:
            w.update(job, stage=f'Getting your animals… ({i + 1} of {len(cast)})', progress=0.02 + 0.08 * i / len(cast))
            c = cast[i]
            if c['from'] == 'link':
                fetch_link(job, w, folder, i, c)
            elif c['from'] == 'surprise':
                paint(w, folder, i, c)
            else:
                raise RuntimeError(f"Animal {i + 1}'s picture is missing. Make the video again.")
            got.append(i)
    finally:
        if got:
            try:
                share_animals(job, w, others, got)
            except Exception as e:  # (it must never hide why the next animal failed)
                w.log.warning('%s: the animals got could not be shared (%s)', job['id'], e)


def share_animals(job, w, others, got):
    """The animals just got (cast numbers `got`): saved with the job, and copied to the batch's other videos that
    have the same animals and don't have them yet."""
    cast, folder = job['cast'], w.job_dir(job['id'])
    names = [n for i in got for n in (cast[i]['pic'], cast[i].get('real')) if n]
    w.update(job, cast=cast, animal=cast[0]['animal'] or 'animal', label=job_label(job['scene'], cast),
             hook_frames=job.get('hook_frames') or hook_planned(cast))
    batch = [(job, names)]
    for other in others:
        if other['id'] not in w.jobs or all(other['cast'][i].get('pic') for i in got):
            continue
        for name in names:
            shutil.copy(folder / name, w.job_dir(other['id']) / name)
        for i in got:
            if not other['cast'][i].get('pic'):
                other['cast'][i].update({k: cast[i].get(k) for k in ('pic', 'real', 'real_frames', 'real_s', 'real_at',
                                                                       'label', 'animal')})
        w.update(other, cast=other['cast'], animal=cast[0]['animal'] or 'animal',
                 label=job_label(other['scene'], other['cast']),
                 hook_frames=other.get('hook_frames') or hook_planned(other['cast']))
        batch.append((other, names))
    w.save_many(batch)


def decide(job):
    """What the job makes now: 'ai' (one scene), 'turns' (one by one) or a free look. A fallback the worker chose
    (one by one when the picture couldn't be made, the free look when the AI was offline) stays until the look is
    changed in Edit."""
    look = job.get('look') if job.get('look') in LOOKS else 'ai'
    if look == 'free':
        return free_look(job.get('scene'), len(job['cast']))
    if look == 'turns':
        return 'turns'
    return job['made_as'] if job.get('made_as') in ('turns',) + FREE_LOOKS else 'ai'


def has_picture(job):
    return bool(job.get('inputs')) and job['inputs'][0] == 'input_0.jpg'


def compose(job, w):
    """The start picture of one scene (input_0.jpg): all the animals in it, from the first composer that makes it,
    with one more try on the plain sofa picture if it was refused. True when it is made; False when it couldn't
    be (then each animal gets its own part, with a note). Out of free time: the job waits (raised), or with the
    user's PC on it goes one by one there (the PC animates for free; it can't make the picture)."""
    folder = w.job_dir(job['id'])
    cast = job['cast']
    pics = {i: w.local_file(job, c['pic']) for i, c in enumerate(cast)}
    tell_apart(cast, pics)
    refs = [shrink_ref(pics[i], folder / f'ref_{i}.jpg') for i in range(len(cast))]
    w.update(job, stage='Putting them in one picture… (about 20 s)', progress=0.12, cast=cast)
    last = None
    for tries, plain in ((1, False), (2, True)):
        prompt = compose_prompt(job['scene'], cast, plain, job.get('idea') or '')
        started = time.time()
        try:
            got = compose_picture(refs, prompt, folder / 'input_0.new.jpg', w)
        except w.QuotaError:
            if not w.pc_online():
                raise
            w.update(job, note=NOTES['pc'], compose={'error': 'out of free GPU time', 'tries': tries})
            return False
        except ComposeError as e:
            w.log.warning('%s: the picture could not be made (try %d): %s', job['id'], tries, e)
            last = e
            continue
        os.replace(folder / 'input_0.new.jpg', folder / 'input_0.jpg')
        info = dict(got, prompt=prompt, tries=tries, plain=plain, seconds=round(time.time() - started, 1))
        (folder / 'compose.json').write_text(json.dumps(info))
        for i, word in colours_from_rewrite(got.get('rewrite'), len(cast)).items():
            cast[i]['color'] = cast[i].get('color') or word
        for i, kind in kinds_from_rewrite(got.get('rewrite'), len(cast)).items():
            if kind_of(cast[i]) == 'animal':  # (nobody knew what it was: the composer saw it)
                cast[i]['animal'] = kind
        w.update(job, inputs=['input_0.jpg'], compose=info, cast=cast, note='', animal=cast[0]['animal'] or 'animal',
                 label=job_label(job['scene'], cast), gpu_spent=True)  # (gpu_spent: a friend's use stays used)
        return True
    w.update(job, note=NOTES['turns'], compose={'error': str(last)[:200], 'tries': 2})
    return False


def make_parts(job, kind, count):
    if kind == 'turns':
        return turn_parts(job['scene'], job['cast'], count, job.get('idea') or '')
    return scene_parts(job['scene'], job['cast'], count, job.get('idea') or '',
                       plain=bool((job.get('compose') or {}).get('plain')))


def plan(job, w, kind):
    """The parts of one scene or one by one: made_as, how many parts, how long, their ideas. Parts already made
    stay while the plan is the same; the user's typed lines stay."""
    n, length = len(job['cast']), float(job['length'])
    if kind == 'turns':
        wanted, seconds = turn_plan(n, length)
        inputs, draft = [job['cast'][0]['pic']], False
    else:
        seconds = job['part_seconds']
        wanted = max(1, min(w.MAX_CLIPS, int(round(length / seconds))))
        inputs, draft = job['inputs'], bool(job.get('draft')) and wanted > 1
    have = job.get('ideas') or []
    same = (job.get('made_as') == kind and have and all(i.get('together') and not i.get('free') for i in have)
            and abs(float(job.get('seconds') or 0) - seconds) < 1e-6)
    if not same:
        w.drop_clips(job, 0)
        have = []
    if len(have) > wanted:  # shorter: the parts after the end go
        w.drop_clips(job, wanted)
    if kind == 'ai' and have:  # longer: new parts carry the story on (each part of it once)
        have = more_parts(job, have, wanted)
    elif len(have) != wanted:
        have = have[:wanted] + make_parts(job, kind, wanted)[len(have):]
    for i, text in (job.get('keep_texts') or {}).items():  # the user's own lines from an edit
        if int(i) < len(have):
            have[int(i)].update(caption=text, typed=True)
    w.update(job, made_as=kind, wanted=wanted, seconds=seconds, ideas=have, inputs=inputs, draft=draft,
             keep_texts=None)


def process(job, w):
    """Makes a Together video (the worker's lanes call this instead of their own process): gets the animals, then
    either cuts the free look on the CPU, or makes the AI picture (one scene), pauses for the picture check
    (raises w.Paused: the job waits CHECK_SECONDS, then carries on by itself), and hands the parts to the worker's
    own animate-and-join (w.process). Out of free time or busy GPUs: w.QuotaError / w.BusyError, the job waits
    like any other (the parts made so far stay). The free video engines offline before anything moved: the free
    look now, with a note."""
    gather(job, w)
    kind = decide(job)
    if kind in FREE_LOOKS:
        return free_cut(job, w, kind)
    if kind == 'ai':
        if not has_picture(job):
            if compose(job, w):
                w.update(job, status='waiting', picture_check=True, retry_at=time.time() + CHECK_SECONDS,
                         stage='Picture ready. It starts moving by itself in 2 minutes.', progress=0.2)
                w.save(job, ['input_0.jpg', 'compose.json'])
                raise w.Paused()
            kind = 'turns'
        elif job.get('picture_check'):
            w.update(job, picture_check=False)
    plan(job, w, kind)
    try:
        w.process(job)
    except (w.QuotaError, w.BusyError):
        raise
    except Exception as e:
        made = any(f'clip_{i}.mp4' in (job.get('clips_done') or []) for i in range(job['wanted']))
        if made or not str(e).startswith('The free video engines are offline'):
            raise
        look = free_look(job['scene'], len(job['cast']))
        w.log.warning('%s: nothing could be animated (%s): the %s look instead', job['id'], e, look)
        w.update(job, note=NOTES['offline'].format(how=HOW[look]))
        free_cut(job, w, look)


def song_cuts(job, w, seconds, speed, made=None):
    """Quick cuts on the beat: the song this video gets and where it starts (the same choice as the worker's
    join), then plan_cuts on its bar downbeats. In the layout's own seconds (before the video's speed). made: what
    final.mp4 was made with (the TikTok cut of a video made before layout_cuts were kept): a saved song starts
    where it did then, not where its meme part is now."""
    shown = seconds / speed
    tail = w.OUTRO_SECONDS if w.outro_for(job) else 0.0
    music, info, start = job.get('music', 'funny'), None, 0.0
    try:
        audio, natural, saved = None, 'start', None
        if music == 'upload' and job.get('has_song'):
            audio, natural = w.local_file(job, 'song.m4a'), 'drop'
        elif music == 'mysong' and (mine := w.my_song(job)):
            audio, saved = mine
            if made and made.get('start') is not None:  # (the song's meme part may have moved since)
                saved = float(made['start'])
        elif music != 'none':
            audio = w.music_file(job['track'])
        info = beats.analyse(audio) if audio else None
        if info:
            part = job.get('song_part') if job.get('song_part') in ('start', 'drop', 'custom') else natural
            if saved is not None:
                start = beats.nearest_beat(info, saved)
            elif part == 'custom':
                start = beats.nearest_beat(info, max(0.0, float(job.get('song_start') or 0)))
            else:
                start = beats.pick_start(info, shown + tail, part)
    except Exception as e:  # (cut every 2 s instead)
        w.log.warning('%s: quick cuts without the beat (%s)', job['id'], e)
        info = None
    return [round(c * speed, 4) for c in plan_cuts(info, start, shown, len(job['cast']))]


def free_panels(job, w):
    """Each animal's piece of a free look: its real clip from the start, else its picture (a slow zoom). A real clip
    that is missing or can't be read makes that animal a still (the look must never fail for one clip)."""
    panels = []
    for i, c in enumerate(job['cast']):
        try:
            if c.get('real'):
                src = w.local_file(job, c['real'])
                frames = count_frames(src)  # (reads only the packets: quick)
                if frames < FPS // 2:
                    raise RuntimeError(f'{frames} frames')
                panels.append({'src': src, 'still': False, 'frames': frames, 'start': 0.0})
                continue
        except Exception as e:
            w.log.warning('%s: animal %d as a still (%s)', job['id'], i + 1, e)
        panels.append({'src': w.local_file(job, c['pic']), 'still': True})
    return panels


def layout_key(job, w, look, panels, cuts=None):
    """What a free look's layout.mp4 shows (it is made again only when this changes). cuts: the quick cuts it was
    laid out with (the TikTok cut uses those of final.mp4), else the ones the song gives now."""
    seconds = float(job['length'])
    if look != 'cuts':
        cuts = []
    elif cuts is None:
        cuts = song_cuts(job, w, seconds, w.SPEEDS.get(job.get('speed'), 1.0))
    labels = free_labels(job['scene'], job['cast'], look)
    return json.dumps([look, [str(p['src']) for p in panels], labels, seconds, cuts]), labels, cuts


def lay_out(job, w, look, panels, labels, cuts, out):
    """Renders the free look into `out`; a clip ffmpeg can't use: everyone as a still this time."""
    try:
        return render_layout(look, panels, float(job['length']), out, labels, cuts)
    except subprocess.CalledProcessError as e:
        w.log.warning('%s: the %s look failed (%s); made with the pictures', job['id'], look,
                      (e.stderr or b'').decode(errors='replace')[-300:])
        panels = [{'src': w.local_file(job, c['pic']), 'still': True} for c in job['cast']]
        return render_layout(look, panels, float(job['length']), out, labels, cuts)


def free_cut(job, w, look):
    """A free look: the real clips laid out on the CPU (layout.mp4, made again only when what it shows changes),
    then the worker's own join and finish (w.finish_video) as one clip: caption, music, meme punches, voice, name
    tag, ending. An AI version the video had is kept aside, so switching the look back is just a cut too."""
    folder = w.job_dir(job['id'])
    if job.get('made_as') in ('ai', 'turns') and job.get('ideas'):
        w.update(job, ai_plan={'made_as': job['made_as'], 'ideas': job['ideas'], 'wanted': job['wanted'],
                               'seconds': job['seconds'], 'draft': job.get('draft')})
    seconds = float(job['length'])
    panels = free_panels(job, w)
    key, labels, cuts = layout_key(job, w, look, panels)
    layout = folder / 'layout.mp4'
    if not (layout.exists() and job.get('layout_key') == key):
        w.update(job, stage=STAGES[look], progress=0.3)
        made = lay_out(job, w, look, panels, labels, cuts, layout)
        w.update(job, layout_key=key, layout_hits=made['hits'])
    old = (job.get('ideas') or [{}])[0] if (job.get('ideas') or [{}])[0].get('free') else {}
    line = old.get('caption_t') or free_line(job)
    idea = {'title': 'Together', 'action': '', 'caption_t': line, 'story': True, 'together': True, 'free': look,
            'caption': old['caption'] if old.get('typed') else caption_fill(line, describe_cast(job['cast'])),
            'typed': bool(old.get('typed')), 'hits': job.get('layout_hits') or [], 'moments': [], 'twist': '',
            'style': None}
    for i, text in (job.get('keep_texts') or {}).items():  # the user's own line from an edit
        if int(i) == 0:
            idea.update(caption=text, typed=True)
    w.update(job, made_as=look, wanted=1, seconds=seconds, ideas=[idea], draft=False, picture_check=False,
             keep_texts=None, layout_cuts=cuts)  # (the quick cuts final.mp4 gets: its TikTok cut keeps them)
    w.finish_video(job, folder, [(0, layout)])


def made_parts(job, w):
    """The parts final.mp4 is cut from now, for a re-cut that never asks the AI for anything and never changes the
    job (`job` may be a copy): a free look's one layout clip (laid out again, the same, when it isn't on this disk
    any more, e.g. after a restart), else the AI parts kept, in order. Raises when one can't be had. (For the
    posting plan's TikTok cut: worker.made_parts() returns this for a Together video.)"""
    if job.get('made_as') in FREE_LOOKS:
        look = job['made_as']
        panels = free_panels(job, w)
        # The quick cuts final.mp4 was laid out with (a saved song's meme part may have moved since: the cut
        # points the song gives now aren't the video's), for the check and for laying it out again.
        cuts = job.get('layout_cuts')
        if look == 'cuts' and cuts is None:  # (made before they were kept: from the start the song had then)
            cuts = song_cuts(job, w, float(job['length']), w.SPEEDS.get(job.get('speed'), 1.0), job.get('made_with'))
        key, labels, cuts = layout_key(job, w, look, panels, cuts)
        if key != job.get('layout_key'):
            raise RuntimeError('the free look changed since the video was made')
        layout = w.job_dir(job['id']) / 'layout.mp4'
        if not layout.exists():
            lay_out(job, w, look, panels, labels, cuts, layout)
        return [(0, layout)]
    parts = []
    for i in range(1 if job.get('draft') else job['wanted']):
        name = f'clip_{i}.mp4'
        if name not in (job.get('clips_done') or []):
            break
        parts.append((i, w.local_file(job, name)))
    if not parts:
        raise RuntimeError('no animated parts kept')
    return parts


def opening(job, parts, w):
    """The Real -> AI opening of a Together video, for the worker's join: the real clips side by side (a grid for
    3-4) for the seconds before each picked moment, then the switch to the AI. None when it is off, nothing is
    real, the look is free (all real already) or anything goes wrong: the opening must never cost a video."""
    if not (job.get('opening') and job.get('hook_frames') and parts and parts[0][0] == 0) \
            or job.get('made_as') in FREE_LOOKS:
        return None
    try:
        cast = job['cast']
        panels = free_panels(job, w)
        for p, c in zip(panels, cast):
            if not p['still']:
                p['start'] = max(0.0, float(c.get('real_at') or 0) - HOOK_SECONDS)
        path = w.job_dir(job['id']) / 'opening.mp4'
        key = json.dumps([[str(p['src']) for p in panels], [p.get('start') for p in panels]])
        if not (path.exists() and job.get('opening_key') == key):
            made = render_layout('split' if len(cast) == 2 else 'grid', panels, HOOK_SECONDS, path)
            if w.jobs.get(job['id']) is job:
                w.update(job, opening_key=key, hook_frames=made['frames'])
            else:  # (the posting plan's TikTok cut works on a copy of the job: the job itself isn't saved from it)
                job.update(opening_key=key, hook_frames=made['frames'])
        return {'video': path, 'frames': int(job['hook_frames']), 'framing': 'stretch', 'size': (OUT_W // 2, OUT_H // 2)}
    except Exception as e:
        w.log.warning('%s: no opening this time (%s)', job['id'], e)
        return None


def needs_animation(job):
    """True when the job still needs the AI (a picture or a part), False when it is a cut on the CPU (a free look,
    or parts that are all made): the quick lane."""
    kind = decide(job)
    if kind in FREE_LOOKS:
        return False
    if kind == 'ai' and not has_picture(job):
        return True
    have = job.get('ideas') or []
    if job.get('made_as') != kind or not have or any(i.get('free') for i in have):
        return True
    limit = 1 if job.get('draft') else job['wanted']
    return len(have) < limit or any(f'clip_{i}.mp4' not in (job.get('clips_done') or []) for i in range(limit))


def public(job):
    """What the page sees of a Together video, next to every video's fields."""
    cast = [{'from': c.get('from'), 'animal': c.get('animal') or 'animal', 'name': c.get('name') or '',
             'label': c.get('label') or '', 'has_real': bool(c.get('real')), 'credit': c.get('credit') or '',
             'id': c.get('id') or ''} for c in job.get('cast') or []]
    scene, stash = scene_of(job), job.get('ai_plan') or {}
    turns = job if job.get('made_as') == 'turns' else stash if stash.get('made_as') == 'turns' else {}
    return {'cast': cast, 'scene': job.get('scene'), 'scene_title': scene['title'], 'look': job.get('look') or 'ai',
            # (for the editor: the AI version a free look keeps aside, the AI parts kept, each turn's seconds, and
            # whether its one free copy was made)
            'kept_look': stash.get('made_as'), 'ai_parts': len(job.get('clips_done') or []),
            'turn_seconds': turns.get('seconds'), 'free_copy': bool(job.get('free_copy')),
            'made_as': job.get('made_as'), 'picture_check': bool(job.get('picture_check')),
            'has_picture': has_picture(job), 'compose_engine': (job.get('compose') or {}).get('engine'),
            'free_look': free_look(job.get('scene'), len(cast)), 'note': job.get('note') or '',
            'length': job.get('length'), 'part_seconds': job.get('part_seconds') or 5,
            'uses_ai': shared_uses_ai(job),  # (of the video played and shared: the Post screen's AI label)
            'editable': True}


def _json_list(text, w, what):
    if text is None or text == '':
        return None
    try:
        got = json.loads(text)
    except ValueError:
        got = None
    if not isinstance(got, list):
        raise w.HTTPException(400, f'Could not read the {what}')
    return got


def current_look(job):
    """The look the video has now: 'free' for any free look, else 'ai' or 'turns' (what was asked, before the
    first version)."""
    if job.get('made_as') in FREE_LOOKS:
        return 'free'
    return job.get('made_as') or (job.get('look') if job.get('look') in LOOKS else 'ai')


def edit(w, job, who, f):
    """Edits a Together video (POST /jobs/{id}/edit; the worker passes the form as f, None = not sent, plus its
    new_song / new_song_id). Texts, music, speed and the extras work as for any video (a re-cut), and:
    scene (another card: a new picture and new parts), look ('ai' | 'turns' | 'free'; compared with the look the
    video has now: a free look, or back to the AI version it already had, is just a cut; 'ai' on a video the
    worker made one by one tries the picture again), recompose (↻ New picture: a new picture of them all, so one
    scene; nothing on a free look), order (⇄ Swap places: the animals' new order as their old numbers, e.g.
    [1, 0]), names (one per animal, in the new order), idea, clips (the length in 5 s parts) and redo (part
    numbers). template and animal are ignored, and so is clips from an old page (it sends its number of parts,
    which isn't the length here: a page that sends none of scene, look, names, order or recompose), so an old page
    can't break it. A friend's new picture, or an animated part lost to a change, uses one of their new
    animations."""
    order = _json_list(f.get('order'), w, 'new order')
    names = _json_list(f.get('names'), w, 'names')
    folder = w.job_dir(job['id'])
    with w.jobs_lock:
        if job['status'] == 'working':
            raise w.HTTPException(409, 'Still working on this one. Edit it when it is ready.')
        cast, n = job['cast'], len(job['cast'])
        try:
            order = [int(x) for x in order] if order is not None else list(range(n))
        except (TypeError, ValueError):
            order = []
        if sorted(order) != list(range(n)):
            raise w.HTTPException(400, 'Could not read the new order')
        scene_id = f['scene'] if f.get('scene') in SCENES else job['scene']
        old_idea = job.get('idea') or ''
        idea = old_idea if f.get('idea') is None else w.clean_idea(f['idea'])
        if scene_id == 'own' and not idea:
            raise w.HTTPException(400, 'Describe what they do together')
        now = current_look(job)
        asked = f['look'] if f.get('look') in LOOKS else None
        recompose = bool(f.get('recompose')) and (asked or now) != 'free'  # (a free look uses no picture)
        if recompose and (asked or now) == 'turns':
            asked = 'ai'  # ↻ New picture of a video made one by one: one scene again, from a new picture
        look = asked or now
        stash = job.get('ai_plan') or {}
        new_page = any(f.get(k) is not None for k in ('scene', 'look', 'names', 'order', 'recompose'))
        length = job['length'] if f.get('clips') is None or not new_page else (
            max(1, min(w.MAX_CLIPS, int(f['clips']))) * job['part_seconds'])
        redo = {int(x) for x in re.findall(r'\d+', f.get('redo') or '')}
        new_picture = (scene_id != job['scene'] or recompose or order != list(range(n))
                       or (scene_id == 'own' and idea != old_idea))
        new_parts = new_picture or idea != old_idea
        # Another AI version than the one made (one by one <-> one scene): the parts made for this one go.
        other_ai = look != 'free' and look != now and not (now == 'free' and stash.get('made_as') == look)
        # One by one with another length for each turn: its turns are all made again.
        turns = job if job.get('made_as') == 'turns' else stash if stash.get('made_as') == 'turns' else None
        resized = bool(look == 'turns' and turns and abs(turn_plan(n, length)[1] - float(turns['seconds'])) > 1e-6)
        made = bool(job.get('clips_done'))
        lost = made and (new_parts or other_ai or resized
                         or (look == now != 'free' and bool(redo & set(range(job['wanted'])))))
        repaint = has_picture(job) and new_picture
        if look == 'free':  # (a free look is made on the CPU: it never uses one of a friend's new animations)
            lost = repaint = False
        if who is not w.OWNER and (repaint or lost) and job.get('redos', 0) >= w.GUEST_REDOS:
            raise w.HTTPException(403, f'This video used its {w.GUEST_REDOS} new animations. Change its text or '
                                       'music, or make a new video.')
        # From here on the video changes.
        texts = f.get('texts') or []
        old = job.get('ideas') or []
        typed = {i: x['caption'] for i, x in enumerate(old) if x.get('typed')}
        typed.update({i: t for i, t in enumerate(texts) if i < len(old) and t != old[i].get('caption')})
        if repaint or lost:
            job['redos'] = job.get('redos', 0) + 1
        if order != list(range(n)):
            cast = job['cast'] = [cast[i] for i in order]
        for i, name in enumerate((names or [])[:n]):
            cast[i]['name'] = w.clean_name(str(name or ''))[:20]
        old_music, new_scene = job.get('music'), scene_id != job['scene']
        job.update(scene=scene_id, idea=idea, label=job_label(scene_id, cast), animal=cast[0].get('animal') or 'animal')
        if new_picture:
            job.update(inputs=None, compose=None, picture_check=False)
        if new_parts or other_ai:
            w.drop_clips(job, 0)
            job.update(ideas=[], made_as=None, ai_plan=None)
        if look != now:
            if look == 'free':  # the AI version is kept aside, to come back to
                if job.get('made_as') in ('ai', 'turns') and job.get('ideas'):
                    job['ai_plan'] = {'made_as': job['made_as'], 'ideas': job['ideas'], 'wanted': job['wanted'],
                                      'seconds': job['seconds'], 'draft': job.get('draft')}
                job.update(made_as=None, ideas=[])
            elif job.get('ai_plan') and job['ai_plan'].get('made_as') == look:
                back = job.pop('ai_plan')
                job.update(made_as=back['made_as'], ideas=back['ideas'], wanted=back['wanted'],
                           seconds=back['seconds'], draft=bool(back.get('draft')))
            else:
                job.update(made_as=None, ideas=[])
            job['note'] = ''
        if asked:
            job['look'] = asked
        job['length'] = length
        have = job.get('ideas') or []
        if have and job.get('made_as') == 'turns':
            wanted, seconds = turn_plan(n, length)
            if abs(seconds - float(job.get('seconds') or 0)) > 1e-6:
                w.drop_clips(job, 0)  # (each animal's turn gets another length: all made again)
                job.update(ideas=[], made_as=None)
            elif wanted != job['wanted']:  # the same turns: the ones made stay, the next ones are added (or go)
                w.drop_clips(job, wanted)
                job.update(ideas=have[:wanted] + make_parts(job, 'turns', wanted)[len(have):], wanted=wanted)
        elif have and job.get('made_as') == 'ai':  # (longer: the story carries on, each part of it once)
            wanted = max(1, min(w.MAX_CLIPS, int(round(length / job['part_seconds']))))
            job.update(ideas=more_parts(job, have, wanted), wanted=wanted, draft=bool(job.get('draft')) and wanted > 1)
        if job.get('made_as') in ('ai', 'turns') and job.get('ideas'):  # a part made again takes the ones after it
            w.drop_clips(job, min({i for i in redo if i < job['wanted']} | {job['wanted']}))
        if names is not None:
            refill_captions(job.get('ideas') or [], cast, scene_id)
        if job.get('ideas'):
            for i, text in typed.items():
                if i < len(job['ideas']):
                    job['ideas'][i].update(caption=text, typed=True)
        elif typed:
            job['keep_texts'] = {str(i): t for i, t in typed.items()}
        music = f.get('music')
        if music in w.MUSIC_MODES and music != 'mine':  # (one sound per animal: no video's own sound)
            job['music'] = music
        if f.get('new_song_id'):
            job['song_id'] = f['new_song_id']
        if job['music'] == 'track' and f.get('track') in ideas.MUSIC:
            job['track'] = f['track']
        elif job['music'] == 'funny' and (old_music != 'funny' or new_scene):
            job['track'] = scene_song(scene_id)
        if f.get('new_song'):
            os.replace(f['new_song'], folder / 'song.m4a')
            job.update(has_song=True, upload_name=f.get('upload_name') or '')  # (the posting plan's song to add)
        if f.get('song_part') in ('auto', 'start', 'drop', 'custom'):
            job['song_part'] = f['song_part']
        if f.get('song_start') is not None:
            job['song_start'] = max(0.0, min(3600.0, float(f['song_start'])))
        if f.get('speed') in w.SPEEDS:
            job['speed'] = f['speed']
        for key in ('captions', 'brand', 'meme', 'opening', 'outro'):
            if f.get(key) is not None:
                job[key] = bool(f[key])
        if f.get('voice') in w.VOICES:
            job['voice'] = f['voice']
        job.update(status='queued', stage='In line…', error='', retry_at=None, progress=0)
    w.save(job, ['song.m4a'] if f.get('new_song') else [])
    w.enqueue(job)
    return {**w.public(job), 'animating': w.needs_animation(job)}


def copy(w, job, who, look):
    """A new video of the same animals and scene in another look (POST /jobs/{id}/copy): "Make the VS screen now ·
    free" while the AI one waits for free time. That one free copy (one per video, while it waits for AI time)
    doesn't use a friend's video; any other copy does, like a new video."""
    look = look if look in LOOKS else 'free'
    with w.jobs_lock:
        waits = job['status'] == 'waiting' and not job.get('picture_check') and current_look(job) != 'free'
        free = look == 'free' and waits and not job.get('free_copy')
        if free:
            job['free_copy'] = True  # (taken now: a second tap is a copy like any other)
    if who is not w.OWNER and not free:
        with w.guests_lock:
            if who['uses_left'] <= 0:
                raise w.HTTPException(403, f'No videos left. Ask {w.host_of(who)} for more.')
            who['uses_left'] -= 1
            who['used'] += 1
        w.save_guests()
    with w.jobs_lock:
        group = job.get('group') or w.secrets.token_hex(4)
        job['group'] = group
        mates = [j for j in w.jobs.values() if j.get('group') == group]
        index = 1 + max(j.get('index', 0) for j in mates)
    keep = ('captions', 'seconds', 'animal', 'template', 'music', 'song_id', 'track', 'song_part', 'song_start',
            'speed', 'idea', 'brand', 'meme', 'opening', 'outro', 'voice', 'has_badge', 'has_endcard', 'has_song',
            'upload_name', 'scene', 'length', 'part_seconds', 'label', 'owner', 'owner_name', 'hook_frames')
    new = {k: job.get(k) for k in keep}
    new.update(id=f"{time.strftime('%Y%m%d-%H%M%S')}-{w.secrets.token_hex(3)}", created=time.time(), index=index,
               batch=len(mates) + 1, group=group, kind='together', look=look, made_as=None, status='queued',
               stage='In line…', progress=0, error='', wanted=1, made=0, clips_done=[], chain={}, redos=0,
               picture_check=False, note='', inputs=None, ideas=[], draft=False, unpaid=free,
               cast=json.loads(json.dumps(job['cast'])))
    if free:
        job['free_copy'] = new['id']  # (the page then stops offering it)
    dst = w.job_dir(new['id'])
    flags = {'badge.png': 'has_badge', 'endcard.png': 'has_endcard', 'song.m4a': 'has_song'}
    files = [name for name, flag in flags.items() if new.get(flag)]
    for name in files + cast_files(new['cast']):
        try:
            shutil.copy(w.local_file(job, name), dst / name)
        except Exception as e:  # (that extra goes; a link or painted animal is fetched again by the copy itself)
            w.log.warning('%s: copy without %s (%s)', new['id'], name, e)
            if name in flags:
                new[flags[name]] = False
            for i, c in enumerate(new['cast']):
                if name == c.get('pic'):
                    c['pic'] = None
                elif name == c.get('real'):
                    set_real(c, None, i)
    with w.jobs_lock:
        w.jobs[new['id']] = new
    w.save_many([(job, []), (new, [x for x in files + cast_files(new['cast']) if (dst / x).exists()])])
    return new
