# ideas.py: the idea library for the Animal Antics worker.
# Everything here is mixed at random, so every video gets different ideas.

import math
import random
import re

ACTIONS = [{'title': 'Hip-hop dancer',
  'action': 'stands up on its hind legs like a human and dances hip-hop, bouncing to the beat, swinging its '
            'hips and waving its front paws in the air',
  'captions': ['When the beat drops 💀', "He's been practicing all week"]},
 {'title': 'Moonwalk',
  'action': 'stands up on its hind legs and does a smooth Michael Jackson moonwalk backwards, then spins '
            'once',
  'captions': ['Smooth criminal 🕺', 'Nobody taught him this']},
 {'title': 'Walks like a boss',
  'action': 'stands up on its hind legs and walks forward on two legs like a human with a confident swagger, '
            'swinging its front paws',
  'captions': ['Main character energy', "Bro thinks he's human 😂"]},
 {'title': 'Gym workout',
  'action': 'stands up on its hind legs and does squats like at the gym, very focused, then flexes its front '
            'legs like a bodybuilder',
  'captions': ['Leg day 💪', 'Summer body loading...']},
 {'title': 'Judging you',
  'action': 'stands up on its hind legs, puts its front paws on its hips and stares at the camera, slowly '
            'shaking its head in disappointment',
  'captions': ['When you come home late 🤨', 'The disrespect...']},
 {'title': 'Boxer',
  'action': 'stands up on its hind legs like a boxer and throws fast punches at the air with its front paws, '
            'bouncing on its feet',
  'captions': ["Don't mess with him 🥊", 'Rocky who?']},
 {'title': 'Karate master',
  'action': 'stands up on its hind legs and does karate moves, chopping the air with its front paws and '
            'doing a high kick',
  'captions': ['Black belt unlocked 🥋', 'Hiyaaa!']},
 {'title': 'Air guitar',
  'action': 'stands up on its hind legs and plays a wild air guitar solo, headbanging with its eyes closed',
  'captions': ['Rock star mode 🎸', 'The solo hit different']},
 {'title': 'Phone call',
  'action': 'stands up on its hind legs, holds a smartphone to its ear with one paw and talks, waving the '
            'other paw around like it is arguing',
  'captions': ['"I\'ll call you back" 📱', 'Talking to his lawyer']},
 {'title': 'Floss dance',
  'action': 'stands up on its hind legs and does the floss dance, swinging its front paws side to side very '
            'fast',
  'captions': ['He learned it from Fortnite 💀', 'Too good at this']},
 {'title': 'Gasps and runs',
  'action': 'stands up on its hind legs, sees the camera, gasps with its mouth wide open and runs away on '
            'two legs like a human',
  'captions': ['Caught in 4K 😱', "He wasn't supposed to see that"]},
 {'title': 'Coffee break',
  'action': 'stands up on its hind legs holding a coffee mug in its front paws and takes a slow sip, then '
            'sighs like a tired office worker',
  'captions': ['Monday morning energy ☕', 'Before coffee vs after']},
 {'title': 'Yoga',
  'action': 'stands up on one hind leg in a yoga tree pose with its front paws pressed together above its '
            'head, perfectly calm',
  'captions': ['Inner peace 🧘', 'Namaste']},
 {'title': 'Soldier march',
  'action': 'stands up on its hind legs, salutes with one paw and marches on the spot like a soldier',
  'captions': ['Reporting for duty 🫡', 'Sir yes sir']},
 {'title': 'Twerk',
  'action': 'stands up on its hind legs, turns around and twerks, shaking its back end to the beat',
  'captions': ['Not him twerking 💀', 'Why is he so good at this']},
 {'title': 'Ballet spin',
  'action': 'stands up on the tips of its hind legs like a ballerina and spins gracefully with its front '
            'paws raised above its head',
  'captions': ['Swan lake 🩰', 'Prima ballerina']},
 {'title': 'Gentleman bow',
  'action': 'stands up on its hind legs and bows politely like a gentleman, one paw on its chest and the '
            'other sweeping out to the side',
  'captions': ['Such a gentleman 🎩', 'Good evening madam']},
 {'title': 'Laughing at you',
  'action': 'stands up on its hind legs, points one paw at the camera and laughs hysterically, holding its '
            'belly and bending over',
  'captions': ["He's laughing at me 🤣", 'Me watching you fall']},
 {'title': 'Goal celebration',
  'action': 'stands up on its hind legs and celebrates like a footballer who just scored, running with its '
            'front paws spread wide, then slides on its knees',
  'captions': ['GOOOAL ⚽', 'Ronaldo who?']},
 {'title': 'Sneaky burglar',
  'action': 'stands up on its hind legs and tiptoes sneakily like a cartoon burglar, looking left and right',
  'captions': ['Sneaky mode activated 🕵️', 'Where is he going?']},
 {'title': 'Jumping jacks',
  'action': 'stands up on its hind legs and does jumping jacks, clapping its front paws above its head',
  'captions': ['Morning workout 🏃', 'Fitness influencer']},
 {'title': 'Slip and fall',
  'action': 'walks on its hind legs like a human, then slips and falls flat on its back with its legs in the '
            'air',
  'captions': ['Wait for it 😭', 'He was doing so well']},
 {'title': 'Sings into a mic',
  'action': 'stands up on its hind legs holding a microphone and sings dramatically with its eyes closed, '
            'swaying side to side',
  'captions': ['Hit the high note 🎤', 'Better than me honestly']},
 {'title': 'Macarena',
  'action': 'stands up on its hind legs and does the Macarena dance, moving its front paws to its head and '
            'hips in order',
  'captions': ['Hey Macarena 💃', 'He knows every move']},
 {'title': 'Backflip',
  'action': 'stands up on its hind legs, crouches and does a perfect backflip, then lands and throws its '
            'front paws up like a gymnast',
  'captions': ['10/10 landing 🤸', 'Olympics next']},
 {'title': 'Taxi!',
  'action': 'stands up on its hind legs and waves both front paws high in the air like it is trying to stop '
            'a taxi',
  'captions': ['Late for work 🚕', 'Taxiiiii!']},
 {'title': 'Reads the news',
  'action': 'stands up on its hind legs holding a newspaper in its front paws, reads it, then lowers it and '
            'looks at the camera over the top',
  'captions': ['Did you see the news? 📰', 'Grandpa vibes']},
 {'title': 'Dab',
  'action': 'stands up on its hind legs and does a dab, then a second dab the other way, very proud of '
            'itself',
  'captions': ["Dab on 'em 🫨", 'Still in 2016']},
 {'title': 'Slow clap',
  'action': 'stands up on its hind legs and gives a slow sarcastic clap with its front paws, staring at the '
            'camera',
  'captions': ['Wow. Great job. 👏', 'Proud of you (not)']},
 {'title': 'Impatient',
  'action': 'stands up on its hind legs, crosses its front legs, taps one foot impatiently and looks at its '
            'wrist like checking a watch',
  'captions': ["You're late ⌚", 'Waiting for my food like']},
 {'title': 'Shy dance',
  'action': 'stands up on its hind legs and does a little shy dance, covering its face with its front paws '
            'and wiggling',
  'captions': ["Don't look at me 🙈", 'Shy but talented']},
 {'title': 'Orchestra conductor',
  'action': 'stands up on its hind legs and conducts an invisible orchestra, waving its front paws '
            'dramatically',
  'captions': ['Maestro 🎻', 'And... FORTISSIMO']},
 {'title': 'Morning jog',
  'action': 'jogs on its hind legs like a human doing a morning run, swinging its front paws',
  'captions': ['5am club 👟', 'Running from my problems']},
 {'title': 'Shrug and leave',
  'action': "stands up on its hind legs, shrugs its shoulders like 'okay...', then turns around and walks "
            'away on two legs',
  'captions': ['Okay...', 'Not my problem 🤷']},
 {'title': 'Runway model',
  'action': 'stands up on its hind legs and walks like a runway model, then stops, poses and turns around '
            'dramatically',
  'captions': ['Serving looks 👠', 'Paris fashion week']},
 {'title': 'Tantrum',
  'action': 'stands up on its hind legs and throws a tantrum, stomping its feet and waving its front paws '
            'angrily',
  'captions': ['When you say no treats 😤', 'He wanted the other one']},
 {'title': 'Tai chi',
  'action': 'stands up on its hind legs and does slow tai chi moves with its front paws, completely calm',
  'captions': ['Zen master ☯️', 'Calm before the zoomies']},
 {'title': 'High five',
  'action': 'stands up on its hind legs and gives an enthusiastic high five to someone off camera, then '
            'jumps with joy',
  'captions': ['Best friends 🙌', 'Up top!']},
 {'title': 'Chicken dance',
  'action': 'stands up on its hind legs and does the chicken dance, flapping its front legs like wings',
  'captions': ['Wrong animal 🐔', 'Identity crisis']},
 {'title': 'Fist pump',
  'action': "stands up on its hind legs and pumps its front paw in the air in celebration, shouting 'YES!'",
  'captions': ['When the food bowl is full ✊', "Let's gooo"]},
 {'title': 'Thinker',
  'action': 'stands up on its hind legs and strokes its chin with one paw, deep in thought, then suddenly '
            'points up like it has an idea',
  'captions': ['Big brain time 🤔', 'Planning something']},
 {'title': 'Cha cha slide',
  'action': 'stands up on its hind legs and does the cha cha slide, sliding to the left, then to the right, '
            'then stomping',
  'captions': ['Everybody clap your hands 🪩', 'Party animal']},
 {'title': 'Twerk drop',
  'action': 'stands up on its hind legs, turns around and twerks to the beat, then drops low and bounces back up',
  'captions': ['He heard the beat drop 🍑', 'Shake it 🍑']},
 {'title': 'Look-back twerk',
  'action': 'turns around and twerks while looking back over its shoulder at the camera with a proud face',
  'captions': ['The confidence 💀', 'Why is he so good at this']},
 {'title': 'Wall twerk',
  'action': 'puts its front paws up against the wall and twerks with full energy',
  'captions': ['Caught him practicing 🍑', 'Not him twerking 💀']},
 {'title': 'Slow-mo twerk',
  'action': 'twerks in dramatic slow motion, ears and fur bouncing',
  'captions': ['Slow motion for the haters', 'Every bounce 💀']},
 {'title': 'Honest stare',
  'action': 'freezes mid-move, slowly turns its head and stares straight into the camera with a brutally honest, unimpressed face',
  'captions': ['Moment of honesty...', 'Be honest.']},
 {'title': 'Caught red-handed',
  'action': 'looks at the camera with a guilty face, lowers its ears and slowly looks away, caught red-handed',
  'captions': ['I did it. And I would do it again.', 'Moment of honesty...']},
 {'title': 'Yeah, I did it',
  'action': 'sighs deeply, shrugs its shoulders and gives the camera a calm "yeah, I did it" look',
  'captions': ['No regrets 🤷', 'Moment of honesty...']},
 {'title': 'Side-eye',
  'action': 'slowly side-eyes the camera with a deadpan expression, then blinks once very slowly',
  'captions': ["He's not wrong 💀", 'The side-eye says everything']},
 {'title': 'Half-closed eyes',
  'action': 'stops, looks at the camera and slowly closes its eyes halfway, completely done with everything',
  'captions': ['No thoughts. Just honesty.', 'Me on Monday morning']},
 {'title': 'Telling a secret',
  'action': 'leans close to the camera like it is telling a secret, then pulls back and nods slowly and seriously',
  'captions': ['He told me the truth 😳', 'Moment of honesty...']}]

TWISTS = ['At the end it loses its balance and falls flat on its back.',
 'Suddenly it notices the camera, freezes, and drops back down on all fours like nothing happened.',
 'At the end it trips over its own feet and tumbles over.',
 'Halfway through it stops, looks straight into the camera, then keeps going even harder.',
 'At the end it turns around and walks away on two legs like a boss.',
 'At the end another animal walks in and copies the exact same move.',
 'At the end it bumps into something and pretends it meant to do that.']

SURPRISE_ANIMALS = ['golden retriever',
 'chihuahua',
 'pug',
 'husky',
 'corgi',
 'french bulldog',
 'dachshund',
 'italian greyhound',
 'german shepherd',
 'orange tabby cat',
 'black and white tuxedo cat',
 'fluffy white cat',
 'grumpy grey cat',
 'macaque monkey',
 'baby hippo',
 'small crocodile',
 'giant panda',
 'brown bear',
 'polar bear',
 'capybara',
 'goat',
 'chicken',
 'penguin',
 'raccoon',
 'sloth',
 'goose',
 'kangaroo',
 'llama',
 'pig',
 'duck']

OUTFITS = ['wearing a tiny backwards cap',
 'wearing sunglasses',
 'wearing a little hoodie',
 'wearing a tiny suit and tie',
 'wearing a gold chain',
 'wearing a bandana']

STYLES = {'phone': {'title': 'Phone video',
           'image': 'candid amateur smartphone photo, vertical, natural lighting, slightly imperfect framing',
           'video': 'Realistic handheld smartphone video'},
 'doorbell': {'title': 'Doorbell cam',
              'image': 'night-time doorbell security camera still, fisheye wide angle lens, slightly grainy, '
                       'infrared-free colour night footage',
              'video': 'Static doorbell security camera footage at night, fisheye lens'},
 'sports': {'title': 'Sports broadcast',
            'image': 'TV sports broadcast frame, bright stadium lights, crowd in the background',
            'video': 'TV sports broadcast footage'},
 'cctv': {'title': 'CCTV',
          'image': 'high-angle CCTV security camera still, wide angle, slightly washed-out colours',
          'video': 'Static high-angle CCTV security camera footage'}}

SCENES = [{'subject': 'a {a} standing upright on its hind legs like a person on a busy street sidewalk in Vietnam, '
             'scooters parked nearby, shop signs',
  'style': 'phone'},
 {'subject': 'three animals, a {a} and two friends, standing upright on their hind legs on a suburban front '
             'porch at night, seen from behind',
  'style': 'doorbell',
  'actions': ['look around at each other, then all start dancing together in sync',
              'slowly turn around, see the camera and wave at it one by one']},
 {'subject': 'a {a} wearing a volleyball jersey with the number 7, standing upright among human players on '
             'the court in a professional volleyball arena',
  'style': 'sports',
  'actions': ['jumps high and spikes the volleyball over the net, then screams and celebrates while its '
              'human teammates hug it']},
 {'subject': "a {a} sitting in the driver's seat of a car, front paws on the steering wheel, seen from the "
             'passenger side',
  'style': 'phone',
  'actions': ['drives the car, turning the steering wheel casually with one paw, then looks at the camera '
              'and honks the horn']},
 {'subject': 'a {a} standing upright at a kitchen stove wearing a chef hat, a frying pan in its paw',
  'style': 'phone',
  'actions': ['flips a pancake in the frying pan like a professional chef, then tastes it and kisses its paw '
              "like 'perfect'"]},
 {'subject': 'a {a} standing upright in a gym next to a barbell on the floor',
  'style': 'phone',
  'actions': ['picks up the heavy barbell, lifts it over its head and roars, then drops it']},
 {'subject': 'a {a} standing upright on its hind legs in a living room with a sofa and wooden floor',
  'style': 'phone'},
 {'subject': 'a {a} sitting on a toilet in a bathroom reading a newspaper like a human',
  'style': 'phone',
  'actions': ['turns the page of the newspaper, then slowly lowers it and glares at the camera, annoyed']},
 {'subject': 'a {a} standing upright on its hind legs on green grass in a sunny park', 'style': 'phone'},
 {'subject': 'a {a} riding a small motorbike on a quiet street, front paws on the handlebars',
  'style': 'phone',
  'actions': ['rides the motorbike down the street wobbling, then crashes softly into a bush and climbs out '
              'embarrassed']},
 {'subject': 'a {a} sitting upright at an office desk wearing a tie, typing on a computer keyboard',
  'style': 'phone',
  'actions': ['types furiously on the keyboard, then slams the desk with both paws in frustration']},
 {'subject': 'a {a} standing upright pushing a shopping cart in a supermarket aisle',
  'style': 'cctv',
  'actions': ['pushes the shopping cart, grabs a bag of snacks from the shelf and sneakily hides it in the '
              'cart, looking around']},
 {'subject': 'a {a} wearing a tiny suit standing upright on a wedding dance floor, guests around',
  'style': 'phone',
  'actions': ['breaks into wild dance moves on the dance floor while the wedding guests cheer and clap']},
 {'subject': 'a {a} wearing sunglasses standing upright on a sunny beach by the water',
  'style': 'phone',
  'actions': ['struts along the shore like a supermodel, then stops and strikes a pose']},
 {'subject': 'a {a} standing upright against a living room wall holding a can of bug spray, a big spider on '
             'the wall',
  'style': 'phone',
  'actions': ['sprays the spider, then panics and jumps back screaming when the spider moves']},
 {'subject': 'a {a} standing upright on a balcony at night, city lights and the Eiffel Tower behind it',
  'style': 'phone'},
 {'subject': 'a {a} standing upright on its hind legs in a parking lot next to a car', 'style': 'cctv'},
 {'subject': 'a {a} standing upright behind the counter of a small fast food shop wearing a cap',
  'style': 'cctv',
  'actions': ['takes an order, hands a burger over the counter and waves goodbye to the customer']}]

GENERIC_CAPTIONS = ['Okay...',
 'Caught on camera 😭',
 'POV: you left the house for 5 minutes',
 'Not him doing this again 💀',
 "Bro thinks he's human 😂",
 'The confidence 😂',
 'He knew I was filming',
 'Nobody: ... My {a}:',
 "This is why I can't leave him alone"]

HASHTAGS = '#funnyanimals #animalsoftiktok #aivideo #funnyvideos #fyp #viral'

SOUND_IDEAS = ['Monkeys Spinning Monkeys',
 'Sneaky Snitch',
 'Oh No (Kreepa)',
 'Funkytown',
 'Caramelldansen',
 'Fluffing a Duck',
 'Cha Cha Slide',
 'phonk remix']

# Free meme classics by Kevin MacLeod (incompetech.com), licensed CC BY 4.0: free to use with credit.
MUSIC = {
    'Monkeys Spinning Monkeys': 'https://incompetech.com/music/royalty-free/mp3-royaltyfree/Monkeys%20Spinning%20Monkeys.mp3',
    'Sneaky Snitch': 'https://incompetech.com/music/royalty-free/mp3-royaltyfree/Sneaky%20Snitch.mp3',
    'Fluffing a Duck': 'https://incompetech.com/music/royalty-free/mp3-royaltyfree/Fluffing%20a%20Duck.mp3',
    'Scheming Weasel faster': 'https://incompetech.com/music/royalty-free/mp3-royaltyfree/Scheming%20Weasel%20faster.mp3',
    'Pixel Peeker Polka - faster': 'https://incompetech.com/music/royalty-free/mp3-royaltyfree/Pixel%20Peeker%20Polka%20-%20faster.mp3',
    'Investigations': 'https://incompetech.com/music/royalty-free/mp3-royaltyfree/Investigations.mp3',
    'Local Forecast - Elevator': 'https://incompetech.com/music/royalty-free/mp3-royaltyfree/Local%20Forecast%20-%20Elevator.mp3',
    'Run Amok': 'https://incompetech.com/music/royalty-free/mp3-royaltyfree/Run%20Amok.mp3',
    'Carefree': 'https://incompetech.com/music/royalty-free/mp3-royaltyfree/Carefree.mp3',
    'Wallpaper': 'https://incompetech.com/music/royalty-free/mp3-royaltyfree/Wallpaper.mp3',
    'Hitman': 'https://incompetech.com/music/royalty-free/mp3-royaltyfree/Hitman.mp3',
    'Spazzmatica Polka': 'https://incompetech.com/music/royalty-free/mp3-royaltyfree/Spazzmatica%20Polka.mp3',
    'Hall of the Mountain King': 'https://incompetech.com/music/royalty-free/mp3-royaltyfree/Hall%20of%20the%20Mountain%20King.mp3',
    'Quirky Dog': 'https://incompetech.com/music/royalty-free/mp3-royaltyfree/Quirky%20Dog.mp3',
    'Kool Kats': 'https://incompetech.com/music/royalty-free/mp3-royaltyfree/Kool%20Kats.mp3',
    'Life of Riley': 'https://incompetech.com/music/royalty-free/mp3-royaltyfree/Life%20of%20Riley.mp3',
}
MUSIC_CREDIT = 'Music: "{track}" by Kevin MacLeod (incompetech.com), CC BY 4.0'

FAIL_TWISTS = [
    'At the end it loses its balance and falls flat on its back.',
    'At the end it trips over its own feet and tumbles over.',
    'At the end it slips and crashes down in a heap, then looks around embarrassed.',
]

# Styles the user can pick in the app: the moves each one uses and the tracks that suit it.
TEMPLATES = {
    'random': {'label': 'Random', 'moves': [], 'music': list(MUSIC)},
    'dance': {'label': 'Dance', 'music': ['Monkeys Spinning Monkeys', 'Fluffing a Duck', 'Pixel Peeker Polka - faster', 'Kool Kats'],
              'moves': ['Hip-hop dancer', 'Moonwalk', 'Floss dance', 'Twerk', 'Ballet spin', 'Macarena', 'Shy dance',
                        'Chicken dance', 'Cha cha slide', 'Dab']},
    'walk': {'label': 'Walk like a human', 'music': ['Sneaky Snitch', 'Investigations', 'Hitman', 'Quirky Dog'],
             'moves': ['Walks like a boss', 'Runway model', 'Sneaky burglar', 'Morning jog', 'Shrug and leave',
                       'Gasps and runs', 'Taxi!', 'Soldier march']},
    'fight': {'label': 'Fight', 'music': ['Run Amok', 'Scheming Weasel faster', 'Hall of the Mountain King'],
              'moves': ['Boxer', 'Karate master', 'Gym workout', 'Jumping jacks', 'Tantrum', 'Backflip']},
    'fail': {'label': 'Fail', 'music': ['Run Amok', 'Fluffing a Duck', 'Spazzmatica Polka'], 'twists': FAIL_TWISTS,
             'moves': ['Slip and fall', 'Walks like a boss', 'Moonwalk', 'Ballet spin', 'Backflip', 'Runway model',
                       'Morning jog']},
    'sassy': {'label': 'Sassy', 'music': ['Local Forecast - Elevator', 'Sneaky Snitch', 'Wallpaper'],
              'moves': ['Judging you', 'Slow clap', 'Impatient', 'Laughing at you', 'Thinker', 'Phone call',
                        'Coffee break', 'Reads the news', 'Gentleman bow']},
    'twerk': {'label': 'Twerk', 'music': ['Monkeys Spinning Monkeys', 'Kool Kats', 'Pixel Peeker Polka - faster', 'Fluffing a Duck'],
              'moves': ['Twerk', 'Twerk drop', 'Look-back twerk', 'Wall twerk', 'Slow-mo twerk']},
    'honest': {'label': 'Moment of honesty', 'music': ['Local Forecast - Elevator', 'Wallpaper', 'Investigations'],
               'moves': ['Honest stare', 'Caught red-handed', 'Yeah, I did it', 'Side-eye', 'Half-closed eyes',
                         'Telling a secret', 'Judging you']},
    'star': {'label': 'Star moment', 'music': ['Monkeys Spinning Monkeys', 'Carefree', 'Life of Riley'],
             'moves': ['Goal celebration', 'Air guitar', 'Sings into a mic', 'Orchestra conductor', 'Fist pump',
                       'High five', 'Yoga', 'Tai chi']},
}

# Words in a video's title or description that tell us which animal it is.
ANIMAL_WORDS = {
    'dog': ['dog', 'dogs', 'puppy', 'puppies', 'pup', 'doggo', 'doggy', 'retriever', 'labrador', 'husky',
            'chihuahua', 'pug', 'corgi', 'bulldog', 'shepherd', 'poodle', 'dachshund', 'beagle', 'pitbull',
            'greyhound', 'whippet', 'shiba', 'malinois', 'rottweiler', 'doberman', 'terrier', 'spaniel'],
    'cat': ['cat', 'cats', 'kitten', 'kittens', 'kitty', 'meow', 'tabby', 'feline'],
    'monkey': ['monkey', 'monkeys', 'macaque', 'chimp', 'chimpanzee', 'gorilla', 'baboon', 'orangutan', 'ape'],
    'parrot': ['parrot', 'parrots', 'cockatoo', 'macaw', 'budgie', 'parakeet'],
    'bird': ['bird', 'birds', 'pigeon', 'crow', 'owl', 'sparrow'],
    'duck': ['duck', 'ducks', 'duckling'],
    'goose': ['goose', 'geese'],
    'chicken': ['chicken', 'chickens', 'hen', 'rooster', 'chick'],
    'goat': ['goat', 'goats'],
    'sheep': ['sheep', 'lamb'],
    'cow': ['cow', 'cows', 'calf', 'cattle'],
    'horse': ['horse', 'horses', 'pony', 'foal'],
    'donkey': ['donkey', 'donkeys'],
    'pig': ['pig', 'pigs', 'piglet'],
    'rabbit': ['rabbit', 'rabbits', 'bunny', 'bunnies'],
    'hamster': ['hamster', 'hamsters'],
    'guinea pig': ['guinea'],
    'bear': ['bear', 'bears', 'grizzly'],
    'panda': ['panda', 'pandas'],
    'capybara': ['capybara', 'capybaras'],
    'raccoon': ['raccoon', 'raccoons'],
    'fox': ['fox', 'foxes'],
    'squirrel': ['squirrel', 'squirrels'],
    'hippo': ['hippo', 'hippos', 'hippopotamus'],
    'elephant': ['elephant', 'elephants'],
    'penguin': ['penguin', 'penguins'],
    'otter': ['otter', 'otters'],
    'seal': ['seal', 'seals'],
    'kangaroo': ['kangaroo', 'kangaroos'],
    'llama': ['llama', 'llamas', 'alpaca'],
    'sloth': ['sloth', 'sloths'],
    'crocodile': ['crocodile', 'alligator', 'croc'],
}


def guess_animal(text):
    """The animal named most often in the text, or 'animal' if none."""
    words = re.findall(r'[a-z]+', (text or '').lower())
    best, best_count = 'animal', 0
    for animal, names in ANIMAL_WORDS.items():
        count = sum(words.count(n) for n in names)
        if count > best_count:
            best, best_count = animal, count
    return best


def _fill(text, animal):
    return text.replace('{a}', animal)


def template_moves(template):
    """The moves a style uses (every move for Random)."""
    names = TEMPLATES.get(template, TEMPLATES['random'])['moves']
    return [a for a in ACTIONS if a['title'] in names] or ACTIONS


def pick_twist(template):
    twists = TEMPLATES.get(template, {}).get('twists')
    if twists:
        return random.choice(twists)
    return random.choice(TWISTS) if random.random() < 0.5 else ''


def pick_music(template):
    """A free track that suits the style."""
    return random.choice(TEMPLATES.get(template, TEMPLATES['random'])['music'])


def ideas_for_picture(animal, count, template='random'):
    """Ideas for a clip or photo the user brought: moves that fit anywhere."""
    out = []
    for act in random.sample(template_moves(template), count):
        caption = random.choice(act['captions']) if random.random() < 0.75 else _fill(random.choice(GENERIC_CAPTIONS), animal)
        out.append({'title': act['title'], 'action': act['action'], 'caption': caption,
                    'twist': pick_twist(template), 'style': None})
    return out


def ideas_for_scene(scene, animal, count, template='random'):
    """Ideas for a Surprise scene: with Random, the scene's own moves come first."""
    own = [{'title': 'Made for this scene', 'action': a, 'caption': _fill(random.choice(GENERIC_CAPTIONS), animal)}
           for a in scene.get('actions', [])] if template in ('random', '', None) else []
    extra = [{'title': a['title'], 'action': a['action'], 'caption': random.choice(a['captions'])}
             for a in random.sample(template_moves(template), count)]
    picked = (own + extra)[:count]
    for idea in picked:
        idea['twist'] = pick_twist(template)
        idea['style'] = scene['style']
    return picked


# ---------- The user's own description ----------
# Rules, not an AI model, so it's free and instant: a description that tells a little story
# ("plays the drums, then falls off the chair") gives each clip its own part of it, and each part
# is matched with the closest move in ACTIONS for a fitting caption (and, when the user's words are
# short, that move's detailed body movements, which the video model follows better).

_COMMON = {'the', 'and', 'then', 'with', 'his', 'her', 'its', 'like', 'into', 'for', 'this', 'that', 'they', 'some',
           'very', 'while', 'from', 'off', 'out', 'over', 'onto', 'once', 'stand', 'hind', 'leg', 'human', 'front',
           'paw', 'camera', 'look', 'slow', 'slowly', 'start', 'end', 'make', 'get', 'doe', 'it', 'him', 'she', 'he'}


def _stem(word):
    for suffix in ('ing', 'ed', 'es', 's'):
        if word.endswith(suffix) and len(word) - len(suffix) >= 3:
            word = word[:-len(suffix)]
            break
    if len(word) > 3 and word[-1] == word[-2] and word[-1] not in 'aeiou':  # stopping -> stopp -> stop
        word = word[:-1]
    return word.rstrip('e') if len(word) > 3 else word


def _stems(text):
    return {_stem(w) for w in re.findall(r'[a-z]+', text.lower()) if len(w) > 2} - _COMMON


_ACTION_STEMS = [_stems(a['title'] + ' ' + a['action']) for a in ACTIONS]
_RARITY = {}
for _found in _ACTION_STEMS:
    for _w in _found:
        _RARITY[_w] = _RARITY.get(_w, 0) + 1
_RARITY = {w: math.log(len(ACTIONS) / n) for w, n in _RARITY.items()}


def match_action(text):
    """The move in ACTIONS closest to the text, and how close (0 = nothing in common). Words that few
    moves use (drums, karate, twerk) count more than common ones. Ties are picked at random, so
    "dances" gives a different dance each time."""
    words = _stems(text)
    scored = [(sum(_RARITY[w] for w in words & found), action) for action, found in zip(ACTIONS, _ACTION_STEMS)]
    top = max(score for score, _ in scored)
    if top <= 0:
        return None, 0.0
    return random.choice([action for score, action in scored if score >= top - 1e-9]), top


CAPTION_MATCH = 1.5  # shares a word that at most ~11 of the 52 moves use
DETAIL_MATCH = 2.3  # shares a word that at most ~5 moves use: safe to add that move's body movements

_THEN = re.compile(r'\s*,?\s*\b(?:and then|but then|then|after that|afterwards|and finally|finally|suddenly|'
                   r'until)\b\s*,?\s*|\s*[.;!?]+\s*', re.I)


def split_beats(text):
    """The parts of a little story, in order: "dances, then falls off the chair" -> 2 parts. A one-word
    part ("then bows") stays with the part before it."""
    beats = []
    for beat in _THEN.split(text or ''):
        beat = beat.strip(' ,')
        if not beat:
            continue
        if beats and len(re.findall(r'[A-Za-z]+', beat)) < 2:
            beats[-1] += f', then {beat}'
        else:
            beats.append(beat)
    return beats


def custom_ideas(text, animal, count, template='random', style=None):
    """The user's own description. A story is shared out over the clips (the last clip takes whatever is
    left, and a clip to spare ends on a reaction); a single action is used for every clip, with a
    different move or ending each time."""
    text = text.strip().rstrip('.')
    beats = split_beats(text) or [text]
    story = len(beats) > 1
    if len(beats) > count:
        beats = beats[:count - 1] + [', then '.join(beats[count - 1:])]
    used, out = set(), []

    def fresh(options):
        options = [c for c in options if c not in used]
        return random.choice(options) if options else None

    for i in range(count):
        if story and i >= len(beats):  # the story is told: end on a reaction, the classic punchline
            move = random.choice(template_moves('honest'))
            out.append({'title': move['title'], 'action': move['action'], 'caption': fresh(move['captions'])
                        or move['captions'][0], 'twist': '', 'style': style, 'story': True})
            used.add(out[-1]['caption'])
            continue
        part = beats[i] if i < len(beats) else text
        move, closeness = match_action(part)
        action = part
        # Short words get the matched move's detailed body movements, which the video model follows better
        # (not for later parts of a story: a move's own setup could contradict what came before).
        if closeness >= DETAIL_MATCH and len(part.split()) <= 6 and (not story or i == 0):
            action = f"{part}: it {move['action']}"
        caption = fresh(move['captions']) if closeness >= CAPTION_MATCH else None
        if not caption and template not in ('random', '', None):
            caption = fresh([c for m in template_moves(template) for c in m['captions']])
        caption = caption or fresh([_fill(c, animal) for c in GENERIC_CAPTIONS]) or _fill(GENERIC_CAPTIONS[0], animal)
        used.add(caption)
        twist = pick_twist(template) if i and not story else ''
        out.append({'title': 'Your idea', 'action': action, 'custom': True, 'caption': caption, 'twist': twist,
                    'style': style, 'story': story})
    return out


def described_scene(text):
    """A Surprise picture painted from the user's own description."""
    animal = guess_animal(text)
    if animal == 'animal':
        animal = random.choice(SURPRISE_ANIMALS)
        text = f'a {animal}: {text}'
    prompt = (f"Photorealistic candid amateur smartphone photo, vertical, natural lighting. {text}. "
              'Realistic fur, real animal anatomy and face, believable everyday footage, no text, no watermark.')
    scene = {'subject': text, 'style': 'phone'}
    return {'scene': scene, 'animal': animal, 'style': STYLES['phone']['title'], 'subject': text, 'prompt': prompt}


def random_scene():
    """A random animal in a random place, plus the prompt for its starting picture."""
    scene = random.choice(SCENES)
    animal = random.choice(SURPRISE_ANIMALS)
    style = STYLES[scene['style']]
    outfit = ', ' + random.choice(OUTFITS) if random.random() < 0.4 else ''
    subject = _fill(scene['subject'], animal) + outfit
    prompt = (f"Photorealistic {style['image']}. {subject}. Realistic fur, real animal anatomy and face, "
              'believable everyday footage, no text, no watermark.')
    return {'scene': scene, 'animal': animal, 'style': style['title'], 'subject': subject, 'prompt': prompt}


def video_prompt(idea, animal, follow=False):
    """The text sent to the video model. follow: the clip carries straight on from the end of the one
    before (its picture is that clip's last frame)."""
    look = STYLES[idea['style']]['video'] if idea.get('style') else 'Realistic video, same camera angle and same place as the picture'
    if follow:
        look += ', carrying straight on from the picture without a cut'
    twist = ' ' + idea['twist'] if idea.get('twist') else ''
    action = idea['action']
    if idea.get('custom'):
        # The user's own words: keep them as a sentence, adding the animal only if they left it out.
        names = ANIMAL_WORDS.get(animal, []) + [animal]
        has_subject = re.match(r'(the|a|an|my|this|that|it|he|she|they|two|three)\b', action, re.I) or \
            any(re.search(rf'\b{re.escape(n)}\b', action, re.I) for n in names)
        sentence = action if has_subject else f'The {animal} {action}'
        sentence = sentence[0].upper() + sentence[1:]
    else:
        sentence = f'The {animal} {action}'
    return (f"{look}. {sentence}.{twist} Natural, physically believable movement, "
            f'the {animal} keeps exactly the same look, fur and face' + (', same colours and light.' if follow else '.'))
