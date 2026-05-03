import re

text = open('STORY_BLUEPRINT.md').read()
sentences = re.split(r'(?<=[.!?]) +|\n', text)

characters = {
    'Erik': 'M',
    'Roland': 'M',
    'Vauclair': 'M',
    'Tomás': 'M',
    'Reyes': 'M',
    'Adriana': 'F',
    'Reed': 'M',
    'Halloran': 'M',
    'Felix': 'M',
    'Crane': 'M',
    'Eve': 'F',
    'Sandoval': 'F',
    'Leonard': 'M',
    'Beckwith': 'M',
    'Yuri': 'M',
    'Lemekhin': 'M',
    'Hugo': 'M',
    'Vivienne': 'F',
    'Ben': 'M',
    'Cora': 'F',
    'Maddie': 'F'
}

male_pronouns = ['he', 'him', 'his', 'himself']
female_pronouns = ['she', 'her', 'hers', 'herself']

for i, sentence in enumerate(sentences):
    words = re.findall(r'\b\w+\b', sentence)
    words_lower = [w.lower() for w in words]
    
    present_chars = [c for c in characters if c in words]
    
    has_male = any(p in words_lower for p in male_pronouns)
    has_female = any(p in words_lower for p in female_pronouns)
    
    male_chars = [c for c in present_chars if characters[c] == 'M']
    female_chars = [c for c in present_chars if characters[c] == 'F']
    
    if len(male_chars) > 0 and len(female_chars) == 0 and has_female:
        print(f"Male chars only but female pronoun: {sentence.strip()}")
    elif len(female_chars) > 0 and len(male_chars) == 0 and has_male:
        print(f"Female chars only but male pronoun: {sentence.strip()}")
